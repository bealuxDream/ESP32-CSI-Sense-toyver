// SPDX-License-Identifier: MIT
// Standalone ESP-IDF classroom demo. See SOURCES.md for Espressif references.
#include <stdio.h>
#include <inttypes.h>
#include <string.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "ping/ping_sock.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "This demo is specifically configured for ESP32-S3. Run idf.py set-target esp32s3."
#endif
#if !CONFIG_ESP_WIFI_CSI_ENABLED
#error "Enable Component config > Wi-Fi > Wi-Fi CSI."
#endif

#define CONNECTED BIT0
#define LLTF_BYTES 128
static const char *TAG = "csi_demo";
static EventGroupHandle_t s_events;
static QueueHandle_t s_frames;
static wifi_ap_record_t s_ap;
static portMUX_TYPE s_stats_lock = portMUX_INITIALIZER_UNLOCKED;
typedef struct {
    uint32_t completed, received, timeouts, jitter_samples;
    uint32_t disconnects, reconnects, last_reason, generation;
    uint64_t rtt_total_ms, jitter_total_ms;
    int32_t last_rtt_ms;
    uint32_t previous_rtt_ms;
    bool previous_valid, ever_connected;
    char gateway[16];
} net_stats_t;
static net_stats_t s_stats = {.last_rtt_ms = -1, .gateway = "0.0.0.0"};

// Completed ICMP outcomes are counted independently of CSI display samples.
static void ping_success(esp_ping_handle_t handle, void *arg)
{
    uint32_t rtt = 0;
    if (esp_ping_get_profile(handle, ESP_PING_PROF_TIMEGAP, &rtt, sizeof(rtt)) != ESP_OK) return;
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.completed++;
    s_stats.received++;
    s_stats.rtt_total_ms += rtt;
    if (s_stats.previous_valid) {
        s_stats.jitter_total_ms += rtt > s_stats.previous_rtt_ms ?
            rtt - s_stats.previous_rtt_ms : s_stats.previous_rtt_ms - rtt;
        s_stats.jitter_samples++;
    }
    s_stats.previous_rtt_ms = rtt;
    s_stats.previous_valid = true;
    s_stats.last_rtt_ms = (int32_t)rtt;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void ping_timeout(esp_ping_handle_t handle, void *arg)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.completed++;
    s_stats.timeouts++;
    s_stats.last_rtt_ms = -1;
    s_stats.previous_valid = false;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void output_network_stats(void)
{
    net_stats_t n;
    portENTER_CRITICAL(&s_stats_lock);
    n = s_stats;
    portEXIT_CRITICAL(&s_stats_lock);
    wifi_ap_record_t ap;
    bool connected = (xEventGroupGetBits(s_events) & CONNECTED) &&
        esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
    // Explicitly report disconnected/unknown RSSI as a sentinel, not the old value.
    printf("NET,%" PRIu32 ",%u,%d,%u,%" PRIu32 ",%" PRIu32 ",%" PRIu32
           ",%" PRIu64 ",%" PRId32 ",%" PRIu64 ",%" PRIu32 ",%" PRIu32
           ",%" PRIu32 ",%" PRIu32 ",%s\n",
        (uint32_t)(esp_timer_get_time() / 1000), connected ? 1 : 0,
        connected ? ap.rssi : -127, connected ? ap.primary : 0,
        n.completed, n.received, n.timeouts, n.rtt_total_ms, n.last_rtt_ms,
        n.jitter_total_ms, n.jitter_samples, n.disconnects, n.reconnects,
        n.last_reason, n.gateway);
}

typedef struct {
    uint32_t seq;
    uint32_t ms;
    int8_t rssi;
    uint8_t channel;
    uint8_t first_invalid;
    uint8_t sig_mode;
    int8_t iq[LLTF_BYTES];
} csi_frame_t;

// Runs in the Wi-Fi task: copy only. Never print or do signal processing here.
static void csi_rx(void *ctx, wifi_csi_info_t *info)
{
    static uint32_t seq;
    if (!info || !info->buf || info->len < LLTF_BYTES ||
        memcmp(info->mac, s_ap.bssid, 6) != 0 || info->rx_ctrl.cwb != 0) {
        return;
    }
    csi_frame_t frame = {
        .seq = ++seq,
        .ms = (uint32_t)(esp_timer_get_time() / 1000),
        .rssi = info->rx_ctrl.rssi,
        .channel = info->rx_ctrl.channel,
        .first_invalid = info->first_word_invalid,
        .sig_mode = info->rx_ctrl.sig_mode,
    };
    memcpy(frame.iq, info->buf, LLTF_BYTES);
    // A one-item mailbox intentionally keeps the freshest frame.
    xQueueOverwrite(s_frames, &frame);
}

static void serial_output(void *arg)
{
    csi_frame_t frame;
    char line[768];
    TickType_t wake = xTaskGetTickCount();
    int64_t last_net_us = 0;
    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(CONFIG_DEMO_OUTPUT_INTERVAL_MS));
        if (esp_timer_get_time() - last_net_us >= 1000000) {
            output_network_stats();
            last_net_us = esp_timer_get_time();
        }
        if (xQueueReceive(s_frames, &frame, 0) != pdTRUE) continue;
        int n = snprintf(line, sizeof(line), "CSI,%lu,%lu,%d,%u,%u,%u",
            (unsigned long)frame.seq, (unsigned long)frame.ms, frame.rssi,
            frame.channel, frame.first_invalid, frame.sig_mode);
        for (int i = 0; i < LLTF_BYTES && n > 0 && n < (int)sizeof(line) - 6; ++i) {
            n += snprintf(line + n, sizeof(line) - n, ",%d", frame.iq[i]);
        }
        if (n > 0 && n < (int)sizeof(line) - 1) {
            line[n++] = '\n';
            fwrite(line, 1, n, stdout);
            fflush(stdout);
        }
    }
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ESP_ERROR_CHECK(esp_wifi_connect());
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        bool was_connected = xEventGroupGetBits(s_events) & CONNECTED;
        xEventGroupClearBits(s_events, CONNECTED);
        const wifi_event_sta_disconnected_t *d = data;
        portENTER_CRITICAL(&s_stats_lock);
        if (was_connected) s_stats.disconnects++;
        s_stats.last_reason = d->reason;
        s_stats.previous_valid = false;
        s_stats.last_rtt_ms = -1;
        portEXIT_CRITICAL(&s_stats_lock);
        ESP_LOGW(TAG, "Wi-Fi disconnected (reason %u). Reconnecting...", d->reason);
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) ESP_LOGW(TAG, "Reconnect: %s", esp_err_to_name(err));
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        if (!(xEventGroupGetBits(s_events) & CONNECTED)) {
            portENTER_CRITICAL(&s_stats_lock);
            if (s_stats.ever_connected) s_stats.reconnects++;
            s_stats.ever_connected = true;
            s_stats.generation++;
            portEXIT_CRITICAL(&s_stats_lock);
        }
        xEventGroupSetBits(s_events, CONNECTED);
    }
}

void app_main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    ESP_LOGI(TAG, "CSI Classroom / ESP32-S3 / UART and USB Serial-JTAG / 115200 baud");
    if (!strcmp(CONFIG_DEMO_WIFI_SSID, "YOUR_2G_WIFI")) {
        ESP_LOGE(TAG, "Set your Wi-Fi in: idf.py menuconfig > CSI Classroom Demo");
        return;
    }
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGE(TAG, "NVS needs attention. Back up existing board data before any erase.");
        return;
    }
    ESP_ERROR_CHECK(err);
    s_events = xEventGroupCreate();
    s_frames = xQueueCreate(1, sizeof(csi_frame_t));
    configASSERT(s_events && s_frames);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *netif = esp_netif_create_default_wifi_sta();
    configASSERT(netif);
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    wifi_config_t wifi = {0};
    if (strlen(CONFIG_DEMO_WIFI_SSID) > 32 || strlen(CONFIG_DEMO_WIFI_PASSWORD) > 64) {
        ESP_LOGE(TAG, "SSID/password exceeds Wi-Fi field length.");
        return;
    }
    memcpy(wifi.sta.ssid, CONFIG_DEMO_WIFI_SSID, strlen(CONFIG_DEMO_WIFI_SSID));
    memcpy(wifi.sta.password, CONFIG_DEMO_WIFI_PASSWORD, strlen(CONFIG_DEMO_WIFI_PASSWORD));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N));
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    configASSERT(xTaskCreate(serial_output, "csi_serial", 4096, NULL, 3, NULL) == pdPASS);

    for (;;) {
        ESP_LOGI(TAG, "Waiting for a 2.4 GHz router with DHCP...");
        xEventGroupWaitBits(s_events, CONNECTED, pdFALSE, pdTRUE, portMAX_DELAY);
        if (esp_wifi_sta_get_ap_info(&s_ap) != ESP_OK) continue;
        wifi_csi_config_t csi = {
            .lltf_en = true, .htltf_en = false, .stbc_htltf2_en = false,
            .ltf_merge_en = false, .channel_filter_en = false,
            .manu_scale = false, .shift = 0,
        };
        ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi));
        ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_rx, NULL));
        ESP_ERROR_CHECK(esp_wifi_set_csi(true));
        esp_netif_ip_info_t ip;
        ESP_ERROR_CHECK(esp_netif_get_ip_info(netif, &ip));
        esp_ping_config_t ping = ESP_PING_DEFAULT_CONFIG();
        ping.target_addr.type = IPADDR_TYPE_V4;
        ping.target_addr.u_addr.ip4.addr = ip.gw.addr;
        ping.count = 0;
        ping.interval_ms = CONFIG_DEMO_PING_INTERVAL_MS;
        ping.timeout_ms = 500;
        ping.data_size = 16;
        ping.task_stack_size = 4096;
        uint32_t generation;
        portENTER_CRITICAL(&s_stats_lock);
        snprintf(s_stats.gateway, sizeof(s_stats.gateway), IPSTR, IP2STR(&ip.gw));
        s_stats.previous_valid = false;
        generation = s_stats.generation;
        portEXIT_CRITICAL(&s_stats_lock);
        esp_ping_callbacks_t callbacks = {
            .on_ping_success = ping_success,
            .on_ping_timeout = ping_timeout,
        };
        esp_ping_handle_t handle;
        ESP_ERROR_CHECK(esp_ping_new_session(&ping, &callbacks, &handle));
        ESP_ERROR_CHECK(esp_ping_start(handle));
        ESP_LOGI(TAG, "CSI ready. IP=" IPSTR " gateway=" IPSTR " channel=%u. Open viewer.",
            IP2STR(&ip.ip), IP2STR(&ip.gw), s_ap.primary);
        while (xEventGroupGetBits(s_events) & CONNECTED) {
            portENTER_CRITICAL(&s_stats_lock);
            bool same_connection = generation == s_stats.generation;
            portEXIT_CRITICAL(&s_stats_lock);
            if (!same_connection) break;
            vTaskDelay(pdMS_TO_TICKS(200));
        }
        ESP_ERROR_CHECK(esp_ping_stop(handle));
        ESP_ERROR_CHECK(esp_ping_delete_session(handle));
        ESP_ERROR_CHECK(esp_wifi_set_csi(false));
        xQueueReset(s_frames);
    }
}
