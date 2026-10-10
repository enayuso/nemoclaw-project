# k8s/ - Server 2 (k3s) RBAC

`rbac-readonly.yaml` is the one-time, human-applied recipe granting
`ops-nemoclaw` read-only visibility into Server 2's k3s cluster. This is
the real authorization boundary (see the comment at the top of that file) -
apply it yourself with cluster-admin access, never through an AI agent's
tool calls, same rule as every other secret-adjacent step in this repo.

## Apply

```bash
ssh -p 19012 ops-s002@203.0.113.10
kubectl apply -f rbac-readonly.yaml   # (scp/paste the file over first, or apply from wherever you already have cluster-admin)
```

## Extract the token + CA into Server 6's `.env`

Run from wherever you just applied the manifest (needs cluster-admin read
access to the `ops-monitoring` namespace):

```bash
kubectl -n ops-monitoring get secret ops-nemoclaw-monitor-token -o jsonpath='{.data.token}'  | base64 -d
kubectl -n ops-monitoring get secret ops-nemoclaw-monitor-token -o jsonpath='{.data.ca\.crt}' | base64 -d | base64 -w0
```

The first command's output goes into Server 6's `.env` as `K8S_SA_TOKEN`.
The second (note the extra `base64 -w0` — re-encoding the already-decoded
PEM so it can sit on one line) goes in as `K3S_CA_B64`. Transfer these
directly into `.env` in your own shell session — never through chat, a
ticket, or an agent transcript.

## Rotate the token

Delete and recreate the Secret; the token controller reissues a fresh one
automatically:

```bash
kubectl -n ops-monitoring delete secret ops-nemoclaw-monitor-token
kubectl apply -f rbac-readonly.yaml
```

Then re-extract per above and update `.env` + re-run `bootstrap.sh`.

## Verify the grant is actually read-only before wiring anything else up

```bash
kubectl --token="$(cat /tmp/sa.token)" --certificate-authority=/tmp/ca.crt --server=https://<server2-ip>:6443 auth can-i --list -n dev
# expect ONLY get/list/watch rows, on exactly the resources listed in rbac-readonly.yaml's ClusterRole

kubectl ... get secrets -A        # expect: Forbidden
kubectl ... delete pod xyz -n dev # expect: Forbidden
```
