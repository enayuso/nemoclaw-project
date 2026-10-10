# Running on a Mac (Apple Silicon)

The architecture in this repo was designed with two roles: a **NemoClaw host** ("Server 6" in the docs) and
a **k3s cluster** ("Server 2") whose workloads are monitored. On a single Mac both roles fit on one machine:

| Role in the docs | On a Mac |
|---|---|
| Server 6 — NemoClaw host | your Mac itself (Docker Desktop or Colima provides the container runtime) |
| Server 2 — k3s cluster | a Linux VM on the Mac running k3s, e.g. a Colima profile started with `--kubernetes` |
| SSH tunnel to Server 2 | SSH from the sandbox into that VM, forwarding the k3s API port (same restricted key) |

The scripts don't hard-code any of this — the cluster address lives in `ssh/config-ops-nemoclaw`,
`policies/server2-k8s-tunnel.yaml` and `.env`, so switching to a Mac is a configuration change.

> Status: an earlier NemoClaw dev instance in this project ran on a Mac mini, but this exact single-Mac
> wiring (sandbox + k3s VM on one laptop) has not been run end to end yet — verify each step as you go.

## 1. Tools

```bash
brew install colima docker kubectl gh jq bash node   # bash 5 is needed for scripts/test/*
# or use Docker Desktop instead of colima + docker
```

## 2. Container runtime and the k3s cluster

```bash
# runtime for the NemoClaw sandbox
colima start --cpu 4 --memory 8

# a separate VM that plays "Server 2": k3s + a reachable IP
colima start --profile k3s --kubernetes --network-address
colima list                     # note the k3s profile's ADDRESS (e.g. 192.168.106.2)
kubectl config use-context colima-k3s
kubectl get nodes
```

Deploy something to monitor, in the `dev` namespace the registry expects:

```bash
kubectl create namespace dev
kubectl -n dev create deployment svc-core --image=<your-image>
```

## 3. Read-only access (same as the server setup)

```bash
kubectl apply -f k8s/rbac-readonly.yaml          # see k8s/README.md for token/CA extraction
```

Put the extracted values in `.env` as `K8S_SA_TOKEN` / `K3S_CA_B64`.

## 4. Tunnel-only SSH key into the k3s VM

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ops-nemoclaw-to-server2 -N ""
colima ssh --profile k3s    # then append the public key to ~/.ssh/authorized_keys inside the VM with:
# command="/bin/false",restrict,port-forwarding,permitopen="127.0.0.1:6443" ssh-ed25519 AAAA... ops-nemoclaw-tunnel
```

Then replace the placeholder server values with the VM's:

- `ssh/config-ops-nemoclaw` — `HostName` / the `ProxyCommand` address → the VM's address, `Port 22`,
  `User` → your VM user
- `policies/server2-k8s-tunnel.yaml` — `host` → the VM's address, `port: 22`

## 5. Linux binaries for the sandbox

The sandbox is a Linux container, so `bootstrap.sh` copies **linux/arm64** builds of `kubectl` and `gh` from
`~/bin` (not the macOS builds Homebrew installs):

```bash
mkdir -p ~/bin
curl -Lo ~/bin/kubectl "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/arm64/kubectl"
# gh: download gh_*_linux_arm64.tar.gz from https://github.com/cli/cli/releases and copy bin/gh to ~/bin/gh
```

## 6. NemoClaw, bootstrap, dashboard

Follow the README's Setup from "create the sandbox" onward (`nemoclaw onboard`, `bash bootstrap.sh`, verify).
The dashboard runs directly on the Mac with `npm start` in `dashboard/`; `dashboard/deploy/*.service` is a
Linux systemd unit and is not needed on macOS.

## 7. Tests on macOS

```bash
cd dashboard && npm test
python3 scripts/check-agent-doc-rules.py
/opt/homebrew/bin/bash scripts/test/watcher-queue.test.sh scripts/lib/watcher-common.sh
/opt/homebrew/bin/bash scripts/test/ask-decision.test.sh  scripts/lib/ask-decision.sh
```

macOS ships bash 3.2; the shell harnesses need Homebrew's bash 5.
