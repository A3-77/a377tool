# -*- coding: utf-8 -*-
"""
盯着 a377.xyz 的 NS 是否生效；一旦生效就自动绑到 Pages 项目上。

令牌从环境变量 CF_TOKEN 读，不落盘。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOKEN = os.environ.get("CF_TOKEN", "")
ACC = os.environ.get("CF_ACCOUNT_ID", "")
ZONE_NAME = "a377.xyz"
PROJECT = "a377tool"

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
API = "https://api.cloudflare.com/client/v4"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(req, timeout=40) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return json.loads(exc.read().decode("utf-8"))
        except Exception:
            return {"success": False, "errors": [{"message": f"HTTP {exc.code}"}]}
    except Exception as exc:  # noqa: BLE001  网络抖动不该让整个脚本崩掉
        return {"success": False, "errors": [{"message": f"{type(exc).__name__}: {exc}"}]}


def zone_status():
    d = call("GET", f"/zones?name={ZONE_NAME}")
    for z in (d.get("result") or []):
        return z.get("status"), z.get("id")
    return None, None


def main():
    if not TOKEN:
        print("[x] 没有 CF_TOKEN")
        return 1

    max_rounds = int(os.environ.get("MAX_ROUNDS", "20"))
    interval = int(os.environ.get("INTERVAL", "120"))

    for i in range(1, max_rounds + 1):
        stamp = time.strftime("%H:%M:%S")
        try:
            status, zone_id = zone_status()
        except Exception as exc:  # noqa: BLE001
            print(f"[{i:02d}] {stamp}  查询失败（{type(exc).__name__}），继续等", flush=True)
            if i < max_rounds:
                time.sleep(interval)
            continue
        print(f"[{i:02d}] {stamp}  status={status}", flush=True)

        if status == "active":
            print("NS 已生效，开始绑定自定义域名…", flush=True)
            d = call("POST", f"/accounts/{ACC}/pages/projects/{PROJECT}/domains",
                     {"name": ZONE_NAME})
            if d.get("success"):
                r = d["result"]
                print(f"  ✓ 已绑定: {r.get('name')}  状态={r.get('status')}", flush=True)
            else:
                msgs = "; ".join(str(e.get("message")) for e in d.get("errors", []))
                if "already" in msgs.lower() or "exists" in msgs.lower():
                    print(f"  （域名已绑定过：{msgs}）", flush=True)
                else:
                    print(f"  ✗ 绑定失败: {msgs}", flush=True)
            print("DONE", flush=True)
            return 0

        if i < max_rounds:
            time.sleep(interval)

    print(f"等了 {max_rounds * interval // 60} 分钟还是 pending，先不绑了。", flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
