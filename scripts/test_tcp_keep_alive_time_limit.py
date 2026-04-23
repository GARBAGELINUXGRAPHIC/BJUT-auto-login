import socket
import time

# 测试的空闲间隔时间（单位：秒）
# 分别对应: 5s, 10s, 30s, 60s, 3m30s, 5m30s, 10m, 1h, 6h
INTERVALS = [5, 10, 30, 60, 210, 330, 600, 3600, 21600]

HOST = "www.msftconnecttest.com"
PORT = 80
PATH = "/connecttest.txt"

def test_interval(wait_time):
    print(f"\n========================================")
    print(f"[*] 开始测试空闲等待时间: {wait_time} 秒...")

    try:
        # 1. 建立 TCP 连接
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(10) # 设置读写超时时间为10秒（防止假死卡住）
        s.connect((HOST, PORT))

        # 2. 发送第一次请求
        req1 = f"GET {PATH} HTTP/1.1\r\nHost: {HOST}\r\nConnection: keep-alive\r\n\r\n"
        s.sendall(req1.encode())
        resp1 = s.recv(4096)

        if b"200 OK" not in resp1:
            print("[-] 第一次请求失败，服务器未返回 200 OK")
            s.close()
            return False

        print(f"    [+] 第一次请求成功！连接已建立。")
        print(f"    [zZ] 开始休眠 {wait_time} 秒 (不要关闭终端)...")

        # 3. 保持连接，休眠等待
        time.sleep(wait_time)

        # 4. 尝试在【同一个连接】上发送第二次请求
        print(f"    [*] 休眠结束，尝试复用连接发送第二次请求...")
        req2 = f"GET {PATH} HTTP/1.1\r\nHost: {HOST}\r\nConnection: keep-alive\r\n\r\n"
        s.sendall(req2.encode())

        # 尝试接收响应
        resp2 = s.recv(4096)

        if b"200 OK" in resp2:
            print(f"    [√] 测试通过！在 {wait_time} 秒空闲后，连接依然存活。")
            s.close()
            return True
        elif len(resp2) == 0:
            # 收到 0 字节，说明 TCP 正常挥手断开
            print(f"    [x] 测试失败！服务器【主动】关闭了连接 (收到了 FIN 包)。")
            print(f"        -> 结论：这是 Web 服务器的 Keep-Alive 策略限制，不是 NAT 超时。")
        else:
            print(f"    [x] 测试失败！收到异常响应。")

        s.close()
        return False

    except socket.timeout:
        print(f"    [x] 测试失败！请求超时 (Socket Timeout)。")
        print(f"        -> 结论：【这就是长连接莫名其妙没了！】中间路由器(NAT)悄悄丢弃了连接，导致网络假死。")
        return False
    except ConnectionResetError:
        print(f"    [x] 测试失败！连接被重置 (Connection Reset)。")
        print(f"        -> 结论：防火墙或路由器强行掐断了连接 (发送了 RST 包)。")
        return False
    except BrokenPipeError:
        print(f"    [x] 测试失败！管道破裂 (Broken Pipe)。")
        print(f"        -> 结论：本地系统发现连接已经断开。")
        return False
    except Exception as e:
        print(f"    [x] 测试失败！发生未知错误: {e}")
        return False

if __name__ == "__main__":
    print("=== TCP 长连接保活(NAT超时)探测脚本 ===")
    print(f"目标主机: {HOST}:{PORT}")
    print(f"计划测试间隔: {INTERVALS} 秒\n")

    for wait in INTERVALS:
        success = test_interval(wait)
        if not success:
            print(f"\n[!] 在 {wait} 秒的测试中连接中断。")
            print("[!] 提示：如果短时间测试已经失败，后续更长时间的测试必然失败，脚本将自动停止。")
            break

        # 每次成功后，稍微休息 2 秒再进行下一轮测试
        time.sleep(2)