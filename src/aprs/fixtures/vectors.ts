/** Independently asserted examples; see https://github.com/cybearde/browsersdr/wiki/Signals for provenance. */
export const APRS_FIXTURE_VECTORS = {
  uncompressed: {
    information: "!4903.50N/07201.75W-Test",
    latitudeDegrees: 49.0583333333,
    longitudeDegrees: -72.0291666667,
  },
  weather: {
    information: "_10090556c220s004g005t077r000p000P000h50b09900wRSW",
    windDirectionDegrees: 220,
    windSpeedMetersPerSecond: 1.78816,
    temperatureCelsius: 25,
    humidityPercent: 50,
    pressureHectopascals: 990,
  },
  micE: {
    destination: "T2SP0W",
    information: '`c_Vm6hk/`"49}Jeff Mobile_%',
    latitudeDegrees: 42.5011666667,
    longitudeDegrees: -71.1263333333,
    speedMetersPerSecond: 12 * 0.514444,
    courseDegrees: 276,
  },
} as const;
