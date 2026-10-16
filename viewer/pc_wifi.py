"""Read Windows WLAN metrics and probe its IPv4 gateway; standard library only."""
import ctypes as C
from ctypes import wintypes as W
import ipaddress
import os
import socket
import struct
import threading
import time
import uuid


class GUID(C.Structure):
    _fields_ = [("data1", W.DWORD), ("data2", W.WORD), ("data3", W.WORD), ("data4", C.c_ubyte * 8)]


class Interface(C.Structure):
    _fields_ = [("guid", GUID), ("description", W.WCHAR * 256), ("state", W.DWORD)]


class SSID(C.Structure):
    _fields_ = [("length", W.DWORD), ("data", C.c_ubyte * 32)]


class Association(C.Structure):
    _fields_ = [("ssid", SSID), ("bss_type", W.DWORD), ("bssid", C.c_ubyte * 6),
                ("phy_type", W.DWORD), ("phy_index", W.DWORD), ("quality", W.DWORD),
                ("rx_rate", W.DWORD), ("tx_rate", W.DWORD)]


class Security(C.Structure):
    _fields_ = [("enabled", W.BOOL), ("one_x", W.BOOL), ("auth", W.DWORD), ("cipher", W.DWORD)]


class Connection(C.Structure):
    _fields_ = [("state", W.DWORD), ("mode", W.DWORD), ("profile", W.WCHAR * 256),
                ("association", Association), ("security", Security)]


class EchoReply(C.Structure):
    _fields_ = [("address", W.DWORD), ("status", W.DWORD), ("rtt", W.DWORD),
                ("size", W.WORD), ("reserved", W.WORD), ("data", C.c_void_p)]


class SocketAddress(C.Structure):
    _fields_ = [("address", C.c_void_p), ("length", C.c_int)]


class UnicastAddress(C.Structure):
    _fields_ = [("length", W.DWORD), ("flags", W.DWORD), ("next", C.c_void_p),
                ("socket", SocketAddress), ("prefix_origin", W.DWORD), ("suffix_origin", W.DWORD),
                ("dad_state", W.DWORD), ("valid_lifetime", W.DWORD), ("preferred_lifetime", W.DWORD),
                ("lease_lifetime", W.DWORD), ("prefix_length", C.c_ubyte)]


class GatewayAddress(C.Structure):
    _fields_ = [("length", W.DWORD), ("reserved", W.DWORD), ("next", C.c_void_p), ("socket", SocketAddress)]


class AdapterAddresses(C.Structure):
    # IP_ADAPTER_ADDRESSES_LH through FirstGatewayAddress (Windows Vista+).
    _fields_ = [("length", W.DWORD), ("index", W.DWORD), ("next", C.c_void_p), ("name", C.c_char_p),
                ("unicast", C.c_void_p), ("anycast", C.c_void_p), ("multicast", C.c_void_p),
                ("dns", C.c_void_p), ("dns_suffix", W.LPWSTR), ("description", W.LPWSTR),
                ("friendly_name", W.LPWSTR), ("mac", C.c_ubyte * 8), ("mac_length", W.DWORD),
                ("flags", W.DWORD), ("mtu", W.DWORD), ("if_type", W.DWORD), ("oper_status", W.DWORD),
                ("ipv6_index", W.DWORD), ("zones", W.DWORD * 16), ("prefix", C.c_void_p),
                ("tx_speed", C.c_uint64), ("rx_speed", C.c_uint64), ("wins", C.c_void_p),
                ("gateway", C.c_void_p)]


class WindowsWifi:
    def __init__(self):
        self.wlan = C.WinDLL("wlanapi", use_last_error=True)
        self.wlan.WlanOpenHandle.argtypes = [W.DWORD, C.c_void_p, C.POINTER(W.DWORD), C.POINTER(W.HANDLE)]
        self.wlan.WlanEnumInterfaces.argtypes = [W.HANDLE, C.c_void_p, C.POINTER(C.c_void_p)]
        self.wlan.WlanQueryInterface.argtypes = [W.HANDLE, C.POINTER(GUID), W.DWORD, C.c_void_p,
                                               C.POINTER(W.DWORD), C.POINTER(C.c_void_p), C.c_void_p]
        self.wlan.WlanFreeMemory.argtypes = [C.c_void_p]
        self.wlan.WlanCloseHandle.argtypes = [W.HANDLE, C.c_void_p]
        self.handle = W.HANDLE()
        version = W.DWORD()
        error = self.wlan.WlanOpenHandle(2, None, C.byref(version), C.byref(self.handle))
        if error:
            raise OSError(error, "Windows WLAN 服务不可用")

    def close(self):
        if self.handle:
            self.wlan.WlanCloseHandle(self.handle, None)
            self.handle = W.HANDLE()

    def query(self, guid, opcode, kind):
        size, data = W.DWORD(), C.c_void_p()
        error = self.wlan.WlanQueryInterface(self.handle, C.byref(guid), opcode, None,
                                           C.byref(size), C.byref(data), None)
        if error:
            raise OSError(error, "无法读取 Wi-Fi 状态")
        try:
            if size.value < C.sizeof(kind):
                raise ValueError("Wi-Fi 状态长度异常")
            return kind.from_buffer_copy(C.string_at(data, C.sizeof(kind)))
        finally:
            self.wlan.WlanFreeMemory(data)

    def read(self):
        data = C.c_void_p()
        error = self.wlan.WlanEnumInterfaces(self.handle, None, C.byref(data))
        if error:
            raise OSError(error, "无法枚举 Wi-Fi 网卡")
        try:
            count = C.cast(data, C.POINTER(W.DWORD))[0]
            if count > 64:
                raise ValueError("Wi-Fi 网卡数量异常")
            entries = [Interface.from_buffer_copy(C.string_at(data.value + 8 + i * C.sizeof(Interface),
                                                              C.sizeof(Interface))) for i in range(count)]
        finally:
            self.wlan.WlanFreeMemory(data)
        if not entries:
            return {"status": "no_adapter", "connected": False, "message": "没有检测到 Wi-Fi 网卡。"}
        item = next((x for x in entries if x.state == 1), entries[0])
        result = {"adapter": item.description, "guid": str(uuid.UUID(bytes_le=bytes(item.guid))),
                  "connected": item.state == 1}
        if not result["connected"]:
            return dict(result, status="disconnected", message="电脑 Wi-Fi 未连接；有线连接不计入此视图。")
        try:
            assoc = self.query(item.guid, 7, Connection).association
        except OSError as exc:
            if exc.errno == 5:
                return dict(result, status="permission", message="Windows 拒绝读取 Wi-Fi 详情；请检查系统定位权限及桌面应用访问权限。")
            raise
        result.update(status="connected", ssid=bytes(assoc.ssid.data[:min(32, assoc.ssid.length)]).decode("utf-8", "replace"),
                      quality=assoc.quality, rxMbps=assoc.rx_rate / 1000, txMbps=assoc.tx_rate / 1000,
                      rssi=None, channel=None, message="正在读取电脑实际 Wi-Fi 连接。")
        for opcode, name, kind in [(0x10000102, "rssi", W.LONG), (8, "channel", W.DWORD)]:
            try:
                result[name] = self.query(item.guid, opcode, kind).value
            except OSError:
                pass
        if result["rssi"] is not None and not -127 <= result["rssi"] <= 0:
            result["rssi"] = None
        return result


def ipv4_route(guid):
    """Match the WLAN GUID, rather than whichever adapter owns the global route."""
    target = uuid.UUID(guid)
    api = C.WinDLL("iphlpapi", use_last_error=True)
    api.GetAdaptersAddresses.argtypes = [W.ULONG, W.ULONG, C.c_void_p, C.c_void_p, C.POINTER(W.ULONG)]
    size = W.ULONG(16384)
    for _ in range(3):
        buffer = C.create_string_buffer(size.value)
        error = api.GetAdaptersAddresses(socket.AF_INET, 0x80 | 0x0E, None, buffer, C.byref(size))
        if error != 111:
            break
    if error == 232:  # ERROR_NO_DATA
        return None
    if error:
        raise OSError(error, "无法读取 Wi-Fi IPv4 地址")

    def address(sock):
        if not sock.address or sock.length < 16:
            return None
        raw = C.string_at(sock.address, 16)
        if struct.unpack_from("=H", raw)[0] != socket.AF_INET:
            return None
        return ipaddress.IPv4Address(raw[4:8])

    ptr = C.addressof(buffer)
    while ptr:
        adapter = AdapterAddresses.from_address(ptr)
        try:
            matches = uuid.UUID(adapter.name.decode("ascii")) == target
        except (ValueError, AttributeError, UnicodeError):
            matches = False
        if matches:
            gateway_ptr, gateway = adapter.gateway, None
            while gateway_ptr:
                item = GatewayAddress.from_address(gateway_ptr)
                candidate = address(item.socket)
                if candidate and not candidate.is_unspecified:
                    gateway = candidate
                    break
                gateway_ptr = item.next
            if not gateway:
                return None
            source_ptr, sources = adapter.unicast, []
            while source_ptr:
                item = UnicastAddress.from_address(source_ptr)
                source = address(item.socket)
                if source and item.dad_state == 4 and not source.is_link_local:
                    sources.append((source, item.prefix_length))
                source_ptr = item.next
            if not sources:
                return None
            source = next((ip for ip, prefix in sources if gateway in ipaddress.IPv4Network((ip, prefix), strict=False)), sources[0][0])
            return {"source": str(source), "gateway": str(gateway)}
        ptr = adapter.next
    return None


def ping_gateway(source, destination):
    """Bind the probe to the Wi-Fi source address, even with Ethernet/VPN present."""
    api = C.WinDLL("iphlpapi", use_last_error=True)
    api.IcmpCreateFile.restype = W.HANDLE
    api.IcmpCloseHandle.argtypes = [W.HANDLE]
    api.IcmpSendEcho2Ex.argtypes = [W.HANDLE, W.HANDLE, C.c_void_p, C.c_void_p, W.DWORD, W.DWORD,
                                   C.c_void_p, W.WORD, C.c_void_p, C.c_void_p, W.DWORD, W.DWORD]
    handle = api.IcmpCreateFile()
    if handle == W.HANDLE(-1).value:
        return {"probeStatus": "error", "probeCode": C.get_last_error(), "rtt": None}
    try:
        address = lambda ip: struct.unpack("=I", socket.inet_aton(ip))[0]
        payload = C.create_string_buffer(b"CSI-PC-WIFI")
        reply = C.create_string_buffer(256)
        count = api.IcmpSendEcho2Ex(handle, None, None, None, address(source), address(destination),
                                    payload, len(payload) - 1, None, reply, len(reply), 800)
        status = EchoReply.from_buffer_copy(reply).status if count else C.get_last_error()
        rtt = EchoReply.from_buffer_copy(reply).rtt if count and status == 0 else None
        return {"probeStatus": "ok" if status == 0 and count else "timeout" if status == 11010 else "error",
                "probeCode": status, "rtt": rtt}
    finally:
        api.IcmpCloseHandle(handle)


def summarize(samples):
    probes = [x for x in samples if x.get("probeStatus") in ("ok", "timeout", "error")]
    rtts = [x["rtt"] for x in probes if x["probeStatus"] == "ok"]
    # A failed or missing sample breaks adjacency for jitter.
    jitter = [abs(b["rtt"] - a["rtt"]) for a, b in zip(samples, samples[1:])
              if a.get("probeStatus") == b.get("probeStatus") == "ok" and b["t"] - a["t"] < 2500]
    quality = [x["quality"] for x in samples if x.get("quality") is not None]
    mean = lambda a: sum(a) / len(a) if a else None
    return {"attempts": len(probes), "failures": sum(x["probeStatus"] != "ok" for x in probes),
            "loss": 100 * sum(x["probeStatus"] != "ok" for x in probes) / len(probes) if probes else None,
            "rtt": mean(rtts), "jitter": mean(jitter),
            "qualityMin": min(quality) if quality else None, "qualityMax": max(quality) if quality else None,
            "duration": (samples[-1]["t"] - samples[0]["t"]) / 1000 if len(samples) > 1 else 0}


class WifiMonitor:
    def __init__(self):
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.last_request = 0
        self.thread = None
        self.samples = []
        self.latest = {"status": "starting", "message": "正在读取电脑 Wi-Fi，首次获取网关可能需要数秒。"}

    def snapshot(self):
        with self.lock:
            self.last_request = time.monotonic()
            if self.thread is None:
                self.thread = threading.Thread(target=self.run, daemon=True)
                self.thread.start()
            rows = list(self.samples)
            return {"source": "windows-wlan", "latest": dict(self.latest), "samples": rows,
                    "summary": summarize(rows), "windowSeconds": 30}

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=10)

    def run(self):
        if os.name != "nt":
            with self.lock:
                self.latest = {"status": "unsupported", "message": "电脑 Wi-Fi 监测目前仅支持 Windows。"}
            return
        wifi, identity = None, None
        resumed = True
        try:
            while not self.stop_event.is_set():
                if time.monotonic() - self.last_request > 5:
                    resumed = True
                    self.stop_event.wait(.5)
                    continue
                started = time.monotonic()
                try:
                    if wifi is None:
                        wifi = WindowsWifi()
                    data = wifi.read()
                    row = {"connected": data.get("connected", False), "quality": data.get("quality"),
                           "rssi": data.get("rssi"), "rtt": None, "probeStatus": "unavailable"}
                    connected = data["status"] == "connected"
                    if connected:
                        route = None
                        try:
                            route = ipv4_route(data["guid"])
                        except (OSError, ValueError, RuntimeError):
                            data["message"] = "信号读取正常，但读取 IPv4 网关失败；稍后自动重试。"
                        key = (data["guid"], data["ssid"], route["gateway"] if route else None,
                               route["source"] if route else None)
                        if key != identity or resumed:
                            with self.lock:
                                self.samples = []
                            identity = key
                        if route:
                            data["gateway"] = route["gateway"]
                            row.update(ping_gateway(route["source"], route["gateway"]))
                        elif "失败" not in data["message"]:
                            data["message"] = "信号读取正常；此 Wi-Fi 没有可用的 IPv4 默认网关，暂不探测延迟。"
                    resumed = False
                except Exception as exc:
                    data = {"status": "error", "message": "电脑 Wi-Fi 读取失败，将自动重试。", "errorCode": getattr(exc, "errno", None)}
                    row = {"quality": None, "rssi": None, "rtt": None, "probeStatus": "unavailable", "connected": False}
                    if wifi:
                        wifi.close()
                        wifi = None
                row["t"] = round(time.time() * 1000)
                data["sampledAt"] = row["t"]
                data["probeStatus"] = row["probeStatus"]
                data["probeCode"] = row.get("probeCode")
                with self.lock:
                    self.latest = data
                    self.samples.append(row)
                    self.samples = [x for x in self.samples if x["t"] >= row["t"] - 30000][-90:]
                self.stop_event.wait(max(.05, 1 - (time.monotonic() - started)))
        finally:
            if wifi:
                wifi.close()
