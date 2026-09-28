#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "ad9361.h"
#include "ad9361_api.h"
#include "no_os_delay.h"
#include "no_os_gpio.h"
#include "no_os_spi.h"

EM_JS(int32_t, browser_spi, (uint8_t *data, uint16_t len), {
  return Asyncify.handleAsync(async () => {
    try {
      const result = await Module.bridgeSpi(HEAPU8.slice(data, data + len));
      if (result) HEAPU8.set(result, data);
      return 0;
    } catch (error) {
      Module.bridgeFailure = String(error && error.message || error);
      return -5;
    }
  });
});

EM_JS(void, browser_delay, (uint32_t milliseconds), {
  return Asyncify.handleAsync(() => Module.bridgeDelay(milliseconds));
});

static int32_t bridge_spi_init(struct no_os_spi_desc **desc, const struct no_os_spi_init_param *param) {
  *desc = calloc(1, sizeof(**desc));
  if (!*desc) return -12;
  (*desc)->device_id = param->device_id;
  (*desc)->chip_select = param->chip_select;
  (*desc)->platform_ops = param->platform_ops;
  return 0;
}
static int32_t bridge_spi_xfer(struct no_os_spi_desc *desc, uint8_t *data, uint16_t len) { (void)desc; return browser_spi(data, len); }
static int32_t bridge_spi_remove(struct no_os_spi_desc *desc) { free(desc); return 0; }
static const struct no_os_spi_platform_ops bridge_spi_ops = { .init = bridge_spi_init, .write_and_read = bridge_spi_xfer, .remove = bridge_spi_remove };
int32_t no_os_spi_init(struct no_os_spi_desc **desc, const struct no_os_spi_init_param *param) { return bridge_spi_init(desc, param); }
int32_t no_os_spi_remove(struct no_os_spi_desc *desc) { return bridge_spi_remove(desc); }
int32_t no_os_spi_write_and_read(struct no_os_spi_desc *desc, uint8_t *data, uint16_t len) { return bridge_spi_xfer(desc, data, len); }

static int32_t bridge_gpio_get(struct no_os_gpio_desc **desc, const struct no_os_gpio_init_param *param) {
  *desc = calloc(1, sizeof(**desc));
  if (!*desc) return -12;
  (*desc)->number = param->number;
  (*desc)->platform_ops = param->platform_ops;
  return 0;
}
static int32_t bridge_gpio_optional(struct no_os_gpio_desc **desc, const struct no_os_gpio_init_param *param) {
  if (param->number < 0) { *desc = NULL; return 0; }
  return bridge_gpio_get(desc, param);
}
static int32_t bridge_gpio_remove(struct no_os_gpio_desc *desc) { free(desc); return 0; }
static int32_t bridge_gpio_input(struct no_os_gpio_desc *desc) { (void)desc; return 0; }
static int32_t bridge_gpio_output(struct no_os_gpio_desc *desc, uint8_t value) { (void)desc; (void)value; return 0; }
static int32_t bridge_gpio_get_direction(struct no_os_gpio_desc *desc, uint8_t *direction) { (void)desc; *direction = 1; return 0; }
static int32_t bridge_gpio_set(struct no_os_gpio_desc *desc, uint8_t value) { (void)desc; (void)value; return 0; }
static int32_t bridge_gpio_value(struct no_os_gpio_desc *desc, uint8_t *value) { (void)desc; *value = 0; return 0; }
static const struct no_os_gpio_platform_ops bridge_gpio_ops = {
  .gpio_ops_get = bridge_gpio_get, .gpio_ops_get_optional = bridge_gpio_optional,
  .gpio_ops_remove = bridge_gpio_remove, .gpio_ops_direction_input = bridge_gpio_input,
  .gpio_ops_direction_output = bridge_gpio_output, .gpio_ops_get_direction = bridge_gpio_get_direction,
  .gpio_ops_set_value = bridge_gpio_set, .gpio_ops_get_value = bridge_gpio_value
};

void no_os_udelay(uint32_t usecs) { if (usecs) browser_delay((usecs + 999) / 1000); }
void no_os_mdelay(uint32_t msecs) { if (msecs) browser_delay(msecs); }
struct no_os_time no_os_get_time(void) { struct no_os_time time = {0, 0}; return time; }

#define GPIO_OPS (&bridge_gpio_ops)
#define GPIO_PARAM NULL
#define SPI_DEVICE_ID 0
#define SPI_CS 0
#define SPI_OPS (&bridge_spi_ops)
#define SPI_PARAM NULL
#define AXI_ADC_NOT_PRESENT 1
#include "baseline.inc"

static struct ad9361_rf_phy *phy;
static int32_t last_error;

static int32_t result(int32_t value) { last_error = value; return value; }

EMSCRIPTEN_KEEPALIVE int32_t bridge_last_error(void) { return last_error; }

EMSCRIPTEN_KEEPALIVE int32_t bridge_initialize(double requested_rx_lo_hz) {
  if (phy) { ad9361_remove(phy); phy = NULL; }
  default_init_param.dev_sel = ID_AD9364;
  default_init_param.reference_clk_rate = 40000000;
  default_init_param.two_rx_two_tx_mode_enable = 0;
  default_init_param.one_rx_one_tx_mode_use_rx_num = 1;
  default_init_param.one_rx_one_tx_mode_use_tx_num = 1;
  default_init_param.frequency_division_duplex_mode_enable = 0;
  default_init_param.frequency_division_duplex_independent_mode_enable = 0;
  default_init_param.tdd_use_dual_synth_mode_enable = 0;
  default_init_param.external_rx_lo_enable = 0;
  default_init_param.external_tx_lo_enable = 0;
  default_init_param.ensm_enable_pin_pulse_mode_enable = 0;
  default_init_param.ensm_enable_txnrx_control_enable = 0;
  default_init_param.rx_synthesizer_frequency_hz = (uint64_t)requested_rx_lo_hz;
  default_init_param.tx_synthesizer_frequency_hz = 2400000000ULL;
  default_init_param.tx_lo_powerdown_managed_enable = 1;
	default_init_param.rf_rx_bandwidth_hz = 4800000;
  default_init_param.rx_rf_port_input_select = A_BALANCED;
  default_init_param.tx_attenuation_mdB = 89750;
  default_init_param.update_tx_gain_in_alert_enable = 0;
  default_init_param.xo_disable_use_ext_refclk_enable = 1;
  default_init_param.clk_output_mode_select = CLKOUT_DISABLE;
  default_init_param.lvds_mode_enable = 0;
  default_init_param.single_data_rate_enable = 0;
  // This adapter deliberately keeps the AD9364 in TDD RX state so that TX is
  // never enabled.  In that mode route the multiplexed DDR I/Q stream over P0,
  // the receive port captured by the B205 FPGA.  Dual-port half-port mode
  // splits I and Q across P0/P1 and produces a real-only (mirrored) spectrum.
  default_init_param.single_port_mode_enable = 1;
  default_init_param.half_duplex_mode_enable = 1;
  default_init_param.swap_ports_enable = 0;
  default_init_param.full_port_enable = 0;
  default_init_param.rx_frame_pulse_mode_enable = 1;
  default_init_param.two_t_two_r_timing_enable = 0;
  default_init_param.rx_data_clock_delay = 0;
  default_init_param.rx_data_delay = 15;
  default_init_param.tx_fb_clock_delay = 0;
  default_init_param.tx_data_delay = 15;
  default_init_param.aux_dac1_active_in_tx_enable = 0;
  default_init_param.aux_dac2_active_in_tx_enable = 0;
  default_init_param.gpo0_slave_tx_enable = 0;
  default_init_param.gpo1_slave_tx_enable = 0;
  default_init_param.gpo2_slave_tx_enable = 0;
  default_init_param.gpo3_slave_tx_enable = 0;
  default_init_param.tx_mon_track_en = 0;
  default_init_param.elna_rx1_gpo0_control_enable = 0;
  default_init_param.elna_rx2_gpo1_control_enable = 0;
  default_init_param.elna_gaintable_all_index_enable = 0;
  default_init_param.digital_interface_tune_skip_mode = 2;
  default_init_param.gpio_resetb.number = -1;
  default_init_param.gpio_sync.number = -1;
  return result(ad9361_init(&phy, &default_init_param));
}

EMSCRIPTEN_KEEPALIVE int32_t bridge_set_rate(uint32_t rate) { return result(ad9361_set_rx_sampling_freq(phy, rate)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_get_rate(uint32_t *rate) { return result(ad9361_get_rx_sampling_freq(phy, rate)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_set_bandwidth(uint32_t bandwidth) { return result(ad9361_set_rx_rf_bandwidth(phy, bandwidth)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_get_bandwidth(uint32_t *bandwidth) { return result(ad9361_get_rx_rf_bandwidth(phy, bandwidth)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_set_lo(double frequency) { return result(ad9361_set_rx_lo_freq(phy, (uint64_t)frequency)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_get_lo(double *frequency) { uint64_t value = 0; int32_t ret = ad9361_get_rx_lo_freq(phy, &value); *frequency = (double)value; return result(ret); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_set_input(uint32_t input) { return result(ad9361_set_rx_rf_port_input(phy, input)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_get_input(uint32_t *input) { return result(ad9361_get_rx_rf_port_input(phy, input)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_set_gain_mode(uint8_t mode) { return result(ad9361_set_rx_gain_control_mode(phy, RX1, mode)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_get_gain_mode(uint8_t *mode) { return result(ad9361_get_rx_gain_control_mode(phy, RX1, mode)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_set_ensm(uint32_t mode) { return result(ad9361_set_en_state_machine_mode(phy, mode)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_get_ensm(uint32_t *mode) { return result(ad9361_get_en_state_machine_mode(phy, mode)); }
EMSCRIPTEN_KEEPALIVE int32_t bridge_rx_pll_locked(void) { return (ad9361_spi_read(phy->spi, REG_RX_CP_OVERRANGE_VCO_LOCK) & VCO_LOCK) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int32_t bridge_slow_agc_mode(void) { return RF_GAIN_SLOWATTACK_AGC; }
EMSCRIPTEN_KEEPALIVE int32_t bridge_ensm_rx_mode(void) { return ENSM_MODE_RX; }
EMSCRIPTEN_KEEPALIVE int32_t bridge_ensm_alert_mode(void) { return ENSM_MODE_ALERT; }
