# 官方资料与实现关系

核对日期：2026-10-15。工程为独立、精简的教学实现，未复制官方仓库的大段源代码，也不依赖 esp-csi 的增益控制组件。

1. **ESP-IDF v5.4.2 / ESP32-S3 Wi-Fi 驱动：CSI 定义、布局和配置**  
   https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-guides/wifi.html#wi-fi-channel-state-information  
   用于核对 I/Q 顺序（先虚部后实部）、LLTF 子载波布局、前 4 字节可能无效、回调内不做耗时操作等约束。

2. **Espressif esp-csi 官方仓库**  
   https://github.com/espressif/esp-csi  
   官方说明了一块 ESP32 配合路由器获取 CSI 的方式，以及对路由器与环境的依赖。

3. **官方 csi_recv_router 示例**  
   https://github.com/espressif/esp-csi/tree/master/examples/get-started/csi_recv_router  
   本工程沿用“Ping 网关以促使路由器返回包”的思路，增加独立配置、低频串口输出和本地展示。

4. **ESP32-S3 USB Serial/JTAG 控制台**  
   https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-guides/usb-serial-jtag-console.html  
   用于核对原生 USB 输出和次控制台输出配置。

5. **ESP32-S3 产品说明**  
   https://www.espressif.com/en/products/socs/esp32-s3  
   用于核对该型号的 Wi-Fi 与硬件能力。本包只面向 S3，不把全部 ESP32 系列视为相同硬件。

6. **本包固件编译基线**  
   https://github.com/espressif/esp-idf/releases/tag/v5.4.2  
   对应主仓库提交 `f5c3654a1c2d2a01f7f67def7a0dc48e691f63c0`。具体构建结果见 `VALIDATION.md`。

7. **ESP-IDF ICMP Echo / Ping 配置与运行统计接口**  
   https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/protocols/icmp_echo.html  
   https://github.com/espressif/esp-idf/blob/v5.4.2/components/lwip/include/apps/ping/ping_sock.h  
   用于核对成功/超时回调、`ESP_PING_PROF_TIMEGAP` 和探测超时设置。RSSI 由 `esp_wifi_sta_get_ap_info` 读取。超时率描述 ICMP 探测结果，不等同无线 MAC 层丢包率。

## 讲解时避免过度推断

当前 Windows 构建 / 硬件验证版本为 ESP-IDF v5.5.1，参考对应版本的 [CSI 文档](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/api-guides/wifi.html#wi-fi-channel-state-information) 和 [Windows 安装说明](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/get-started/windows-setup.html)。上述 v5.4.2 链接保留为初始实现的资料来源。

电脑 Wi-Fi 页使用 Microsoft 的 [WlanQueryInterface](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlanqueryinterface)、[GetAdaptersAddresses](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getadaptersaddresses) 和 [IcmpSendEcho2Ex](https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho2ex)，读取常规链路指标，不将它们当作 CSI。

- CSI 是信道信息；本实验不输出目标距离、人数、身份、人体轮廓或医学指标。
- 曲线变化可能来自人、其他物体、天线位置、无线干扰或自动增益。
- 本包阈值是课堂观察工具，没有提供人体检测准确率或探测范围的实验保证。
- 单板加路由器可行不代表任意路由器和任意房间都能直接得到稳定的人体感知效果。
