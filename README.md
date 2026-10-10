# nemoclaw-project

> English: [README_en.md](README_en.md)

**[NVIDIA NemoClaw](https://www.nvidia.com/)**(OpenClaw 에이전트를 샌드박스에서 실행하는 런타임) 위에 구축한
AI 운영(AIOps) 환경이다. NemoClaw 샌드박스 하나가 Kubernetes에서 돌아가는 백엔드 서비스들을 감시하고, 장애가
생기면 AI 에이전트에게 넘겨 원인을 조사·설명하게 한다. **명시적으로 허용된 저장소에 한해서만** 에이전트가 수정안을
GitHub PR로 준비하며, 그 PR도 사람이 승인해야 반영된다.

이 프로젝트의 목적은 실제 운영 업무에서 자율 에이전트를 어디까지 믿을 수 있는지, 그리고 프롬프트로 "부탁"하는 것이
아니라 모델 **바깥**에서 강제해야 하는 것(네트워크 정책, RBAC, SSH 키 제한, git hook)이 무엇인지를 직접 부딪히며
이해하는 것이다. 이 저장소의 코드와 문서 대부분은 **Claude Code**와 페어 프로그래밍으로 작성했다.

## 동작 방식

```
 k3s 클러스터 (Server 2)                   NemoClaw 샌드박스 (Server 6)
 ┌──────────────────────┐   SSH 터널    ┌─────────────────────────────────────────────┐
 │ svc-core, svc-rag,   │◄──(포워딩─────│ tunnel-keeper.sh  (cron, 1분 주기)          │
 │ svc-search, …        │    전용)      │ 저장소별 watcher.sh (cron) ─► kubectl logs  │
 │ 읽기 전용 RBAC SA    │               │        │ 새로운 에러 시그니처?              │
 └──────────────────────┘               │        ▼                                    │
                                        │ <repo>-escalation 에이전트 ─► 조사          │
                                        │        │ (쓰기 허용 저장소만)               │
                                        │        ▼                                    │
                                        │ 수정안 준비 ─► <repo>-reviewer (2차 검토)   │
                                        │        ▼                                    │
                                        │ 사람에게 확인 ─► 브랜치 push / PR 생성      │
                                        └───────────────┬─────────────────────────────┘
                                                        │ Gateway WebSocket API
                                               ┌────────▼────────┐
                                               │ dashboard/ (웹) │  실시간 실행·로그·결정
                                               └─────────────────┘
```

- **레지스트리 기반 온보딩** — 명령 하나(`scripts/register-repo.sh`)로 저장소를 추가한다. `registry/repos.json`이
  단일 정본이고, 저장소별 에이전트 문서(`AGENTS.md`, `TOOLS.md`)·watcher 스크립트·git hook은 `templates/`에서
  렌더링된다.
- **Watcher** — cron으로 도는 셸 스크립트가 읽기 전용 Kubernetes ServiceAccount로 파드 로그를 가져오고, 에러
  시그니처를 쿨다운과 함께 중복 제거해 **새로운** 장애만 에스컬레이션한다.
- **Escalation 에이전트** — 기본은 읽기 전용. `modifications_enabled`가 켜진 저장소만 재현·수정·PR 생성이 가능하며,
  되돌릴 수 없는 단계마다 반드시 멈추고 사람에게 묻는다.
- **Reviewer 에이전트** — 별도의 "2차 의견" 에이전트가 모든 수정안(선택적으로 들어오는 PR까지)을 사람이 보기 전에
  검토한다.
- **다층 방어** — 터널 전용 SSH 키(`command="/bin/false"`, `permitopen`), 시크릿 접근이 없는 읽기 전용 RBAC,
  실행 바이너리까지 구분하는 NemoClaw 네트워크 정책, 시크릿·보호 브랜치 push를 막는 pre-push hook.
- **대시보드** — OpenClaw Gateway의 WebSocket API에 직접 붙는 Node.js 웹 UI. 에이전트에게 작업을 보내고, 텍스트와
  툴 호출을 실시간 스트리밍으로 보고, 파드 로그를 tail하고, 대기 중인 결정에 답할 수 있다.
- **운영 도구** — 재빌드 전 안전 점검(`check-rebuild-safe.sh`), 설정 드리프트 탐지, 자격증명 교체, 샌드박스 전체
  재구축용 복구 런북.

## 왜 Docker가 아니라 Kubernetes인가

처음에는 SSH로 일반 Docker 컨테이너를 감시했고, 이후 k3s 클러스터로 옮겼다. 이 작업에는 Kubernetes가 더
잘 맞았다.

- **실제 권한 경계.** Kubernetes RBAC로 에이전트에게 파드·로그를 `get/list/watch`만 할 수 있는 ServiceAccount를
  줄 수 있다(시크릿 접근·쓰기 불가). Docker에는 이런 장치가 없다 — Docker 소켓 접근은 사실상 root 권한이라, Docker
  버전에서는 강제 명령(forced-command) SSH 래퍼를 직접 만들어야 했다.
- **모든 서비스에 같은 API.** watcher가 라벨(`app=svc-core`)로 워크로드를 찾고 `kubectl logs`로 로그를 읽는다.
  호스트별 SSH·컨테이너 이름을 따로 다룰 필요가 없다.
- **학습.** 그동안 주로 Docker만 다뤄 왔기 때문에, 실제로 돌아가는 시스템 위에서 Kubernetes 개념(namespace,
  deployment, label, RBAC, ServiceAccount, kubeconfig)을 익히려는 의도도 있었다.

## 디렉터리 구조

| 경로 | 내용 |
|---|---|
| `bootstrap.sh` | 새로 온보딩한 샌드박스에 모든 것을 다시 구성(정책, 터널, kubeconfig, MCP, 등록된 저장소) |
| `scripts/` | `register-repo.sh`, `toggle-repo.sh`, `resync-repo.sh`, `deregister-repo.sh`, `prompt-agent.sh`, `check-rebuild-safe.sh`, `check-config-drift.sh`, `rotate-credentials.sh`, `tunnel-keeper.sh`, 공용 라이브러리 `scripts/lib/`, bash 테스트 `scripts/test/` |
| `registry/` | `repos.json`(감시 대상) + `schema.md`(필드 설명) + 부트스트랩 크기 제한 |
| `templates/` | 에이전트 문서·watcher·pre-push hook의 `.tmpl` 원본 |
| `rendered/` | 저장소별 렌더링 결과(템플릿 변경을 diff로 리뷰할 수 있도록 git에 보관) |
| `dashboard/` | Express + `ws` 백엔드, 순수 JS 프런트엔드. [`dashboard/README.md`](dashboard/README.md) 참고 |
| `k8s/`, `kube/`, `policies/`, `ssh/` | 읽기 전용 RBAC 매니페스트, kubeconfig 템플릿, NemoClaw 네트워크 정책 프리셋, SSH 클라이언트 설정 |
| `skills/` | 설치형 OpenClaw 스킬(예: `second-opinion-review`) |
| `workspace/` | 샌드박스 메인 에이전트의 정체성/사용자 프로필 |
| `docs/` | [`macos-setup.md`](docs/macos-setup.md)(Mac 한 대로 구성하기), [`operations.md`](docs/operations.md)(서버 기준 전체 설치 절차·주의사항), [`recovery.md`](docs/recovery.md), [`k8s-migration-architecture.md`](docs/k8s-migration-architecture.md), [`monitoring-live-logs.md`](docs/monitoring-live-logs.md) |
| `attic/` | 이전 Docker/SSH 감시 방식의 폐기된 코드(참고용) |

## 시작하기

### 준비물 (macOS, Apple Silicon)

- [Homebrew](https://brew.sh): `brew install colima docker kubectl gh jq bash node`
  (Colima 대신 Docker Desktop도 가능)
- Mac에 설치한 [NemoClaw](https://www.nvidia.com/)
- 감시할 k3s 클러스터 — Mac에서는 Colima VM으로: `colima start --profile k3s --kubernetes --network-address`
- OpenAI 호환 추론 엔드포인트(나는 Qwen 모델을 서빙하는 자체 호스팅 vLLM을 사용)
- 감시 대상 저장소용 GitHub 계정/PAT

Mac 한 대로 구성하는 단계별 가이드는 [`docs/macos-setup.md`](docs/macos-setup.md)에 있다. 문서에 나오는
"Server 6"은 NemoClaw 호스트(내 Mac), "Server 2"는 k3s 클러스터(Colima VM)를 뜻한다.

### 설치 요약

```bash
# 1. 시크릿 (.env는 절대 커밋하지 않는다)
cp .env.example .env            # GITHUB_PAT, K8S_SA_TOKEN, K3S_CA_B64 등 입력

# 2. 샌드박스 생성 (대화형)
NEMOCLAW_GATEWAY_PORT=8180 nemoclaw onboard --name ops-nemoclaw

# 3. 클러스터 접근 1회 설정 (cluster-admin으로 실행, k8s/README.md 참고)
kubectl apply -f k8s/rbac-readonly.yaml

# 4. 샌드박스에 모든 구성 반영 — 에이전트가 아니라 직접 터미널에서 실행
bash bootstrap.sh

# 5. 확인
nemoclaw ops-nemoclaw doctor
bash scripts/check-rebuild-safe.sh -v
```

### 서비스 등록

```bash
# 모든 옵션은 scripts/register-repo.sh 상단 주석 참고
scripts/register-repo.sh <key> --clone-url https://github.com/<org>/<repo>.git \
  --runtime k8s --namespace dev --workload-kind deployment --workload-name <name> \
  --label-selector app=<name> --modifications off --dry-run
scripts/toggle-repo.sh <key> --modifications on|off    # 수정·PR 권한 부여/회수
scripts/resync-repo.sh --all                           # 템플릿 변경을 전체 저장소에 반영
scripts/prompt-agent.sh <key> escalation -m "마지막 배포 후 왜 재시작됐어?"
```

### 대시보드

```bash
cd dashboard
cp .env.example .env     # Gateway URL/토큰, 로그인 비밀번호, 세션 시크릿
npm ci
npm start                # TLS 설정 시 https://localhost:8443
npm test                 # node --test test/*.test.js
```

## 테스트

```bash
cd dashboard && npm test                                         # 대시보드 단위/통합 테스트
python3 scripts/check-agent-doc-rules.py                          # 렌더링된 에이전트 문서에 안전 규칙이 모두 남아 있는지
# macOS 기본 bash는 3.2 — 셸 테스트에는 Homebrew의 bash 5가 필요하다
/opt/homebrew/bin/bash scripts/test/watcher-queue.test.sh scripts/lib/watcher-common.sh
/opt/homebrew/bin/bash scripts/test/ask-decision.test.sh  scripts/lib/ask-decision.sh
```

## 참고

- 이 저장소의 호스트명, IP(`203.0.113.x` 문서용 대역), 계정, 서비스 이름은 모두 예시 값이다. 자신의 환경에 맞게
  바꿔서 사용한다.
- `docs/`에는 날짜가 붙은 엔지니어링 기록(장애, 버전 업그레이드 후 재검증 등)을 의도적으로 남겨 두었다. 각
  안전장치가 **왜** 생겼는지가 이 프로젝트에서 가장 유용한 부분이기 때문이다.
