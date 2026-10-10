#!/usr/bin/env python3
# SSH ProxyCommand helper: the sandbox's only egress is an HTTP forward proxy
# at 10.200.0.1:3128 (enforced by NemoClaw policy). Plain `ssh` can't speak
# HTTP proxies, so this does a manual HTTP CONNECT to establish a raw tunnel,
# then relays bytes bidirectionally so ssh sees a normal byte stream.
# curl's telnet:// scheme does NOT work here - it does its own protocol
# framing that corrupts the SSH banner. This is the only approach confirmed
# to work (see reference_nemoclaw_ssh_dev_server_access memory).
import socket
import select
import sys

PROXY_HOST = "10.200.0.1"
PROXY_PORT = 3128


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: connect-proxy.py <target-host> <target-port>\n")
        sys.exit(1)
    target_host, target_port = sys.argv[1], sys.argv[2]

    sock = socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=10)
    connect_req = (
        f"CONNECT {target_host}:{target_port} HTTP/1.1\r\n"
        f"Host: {target_host}:{target_port}\r\n"
        f"Connection: keep-alive\r\n\r\n"
    ).encode()
    sock.sendall(connect_req)

    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            sys.stderr.write("connect-proxy: proxy closed connection during CONNECT handshake\n")
            sys.exit(1)
        response += chunk
    status_line = response.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 200 " not in status_line:
        sys.stderr.write(f"connect-proxy: CONNECT failed: {status_line}\n")
        sys.exit(1)

    sock.setblocking(False)
    stdin_fd = sys.stdin.buffer.fileno()
    stdout_fd = sys.stdout.buffer.fileno()

    while True:
        readable, _, _ = select.select([sock, stdin_fd], [], [])
        if sock in readable:
            data = sock.recv(65536)
            if not data:
                break
            import os
            os.write(stdout_fd, data)
        if stdin_fd in readable:
            import os
            data = os.read(stdin_fd, 65536)
            if not data:
                break
            sock.sendall(data)


if __name__ == "__main__":
    main()
