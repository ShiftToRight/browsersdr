import { describe, expect, it, vi } from "vitest";
import {
  FakeUsrpB205ControlIo,
  encodeUsrpB205ControlAck,
} from "../testing/usrpB205ControlFixture";
import { createUsrpB205RequestedConfiguration } from "./usrpB205Capabilities";
import { UsrpB205ControlLink } from "./usrpB205Control";
import type { UsrpB205Fx3Identity } from "./usrpB205Fx3";
import {
  USRP_B205_AD9364_NO_OS_COMMIT,
  USRP_B205_AD9364_PROFILE,
  UsrpB205RxConfigurator,
  type UsrpB205Ad9364Driver,
  type UsrpB205Ad9364Report,
  type UsrpB205RxBoundary,
} from "./usrpB205RxConfig";

const identity: UsrpB205Fx3Identity = {
  kind: "usrp-b205-mini-fx3",
  vendorId: 0x2500,
  productId: 0x0022,
  productName: "USRP B205mini-i",
  serialNumber: "ABC123",
  descriptorLayoutVerified: true,
  firmware: { major: 8, minor: 2 },
  usbSpeed: 3,
  loaderState: 4,
  fpgaLegacyHash: 0x1624155e,
  imageSha256:
    "f4da0becf906af957c954a7a1c276aa91f79ca369d7aedf7c2f5c7fdebf4c351",
  imageDisposition: "already-compatible",
  claimedInterfaces: [4, 3, 2],
  fpgaCompatibilityCheck: "pending-chdr-step-04",
};

function report(center = 5_800_000_001): UsrpB205Ad9364Report {
  return {
    deviceId: "AD9364",
    masterClockRateHz: 38_400_000,
    rxBandwidthHz: 4_799_998,
    rxLoFrequencyHz: center,
    rxInput: "A/RX1",
    gainMode: "slow_agc",
    ensmMode: "RX",
    rxPllLocked: true,
  };
}

function driver(
  overrides: Partial<UsrpB205Ad9364Driver> = {},
): UsrpB205Ad9364Driver {
  return {
    initializeRx: vi.fn(async () => undefined),
    setRxClockPath: vi.fn(async () => undefined),
    setRxBandwidth: vi.fn(async () => undefined),
    enterAlert: vi.fn(async () => "ALERT" as const),
    setRxLo: vi.fn(async (frequencyHz) => ({
      frequencyHz,
      rxPllLocked: true as const,
    })),
    selectRxInput: vi.fn(async () => undefined),
    setRxGainMode: vi.fn(async () => undefined),
    enterRx: vi.fn(async () => "RX" as const),
    readRxReport: vi.fn(async () => report()),
    ...overrides,
  };
}

function fixture() {
  const io = new FakeUsrpB205ControlIo();
  io.responseFor = (request) => {
    const view = new DataView(
      request.buffer,
      request.byteOffset,
      request.byteLength,
    );
    let readback = 0n;
    if (view.getUint32(8, true) === 32) {
      const selector = view.getUint32(12, true);
      if (selector === 0) readback = 0xace0ba5e00070003n;
      if (selector === 1) readback = 0x5an;
      if (selector === 2) readback = 0x0000010000000000n;
      if (selector === 3) readback = 0x2n;
    }
    return encodeUsrpB205ControlAck(request, { readback });
  };
  const closeOwner = vi.fn(async () => undefined);
  const control = new UsrpB205ControlLink(io);
  return { io, closeOwner, control };
}

function decodedWrites(io: FakeUsrpB205ControlIo) {
  return io.writes.map((bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      sid: view.getUint32(4, true),
      address: view.getUint32(8, true),
      value: view.getUint32(12, true),
    };
  });
}

describe("USRP B205-mini constrained RX configuration", () => {
  it("pins the audited no-OS adapter profile and omits every TX-facing method", () => {
    expect(USRP_B205_AD9364_NO_OS_COMMIT).toBe(
      "42d9893169f57b10c3d249a98633051e9ff037be",
    );
    expect(USRP_B205_AD9364_PROFILE).toMatchObject({
      device: "ID_AD9364",
      referenceClockHz: 40_000_000,
      fdd: false,
      tddDualSynth: false,
      txLoPowerdownManaged: true,
      txAttenuationMdB: 89_750,
      updateTxGainInAlert: false,
      txFir: "never-load",
      terminalEnsmMode: "RX",
      interface: "CMOS-DDR-single-port-half-duplex-RX",
      parallelPortSwap: false,
      singlePort: true,
      halfDuplex: true,
      fullPort: false,
      hostSampleRateHz: 4_800_000,
      fpgaRxDecimation: 8,
      rxBandwidthHz: 4_800_000,
      digitalInterfaceTuneSkipMode: 2,
    });
    const exposed = Object.keys(driver()).sort();
    expect(exposed).toEqual([
      "enterAlert",
      "enterRx",
      "initializeRx",
      "readRxReport",
      "selectRxInput",
      "setRxBandwidth",
      "setRxClockPath",
      "setRxGainMode",
      "setRxLo",
    ]);
    expect(
      exposed.some((name) => /tx|fir|bist|loopback|eeprom|flash/i.test(name)),
    ).toBe(false);
  });

  it("executes compatibility, safe ATR, SPI, RF and RX register setup in frozen order", async () => {
    const { io, closeOwner, control } = fixture();
    const rf = driver({
      initializeRx: vi.fn(async (spi, profile, center) => {
        expect(profile).toBe(USRP_B205_AD9364_PROFILE);
        expect(center).toBe(5_801_000_001);
        await spi.writeRegister(0x123, 0x45);
        expect(await spi.readRegister(0x17)).toBe(0x5a);
      }),
      readRxReport: vi.fn(async () => report(5_800_000_001)),
    });
    const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
      closeOwner,
      pause: async () => undefined,
    });
    const details = await configurator.initialize(
      createUsrpB205RequestedConfiguration(5_800_000_001),
    );
    expect(details.configuration).toMatchObject({
      requested: { requestedCenterFrequencyHz: 5_800_000_001 },
      acceptedCenterFrequencyHz: 5_800_000_001,
      centerFrequencyEvidence: "rf-synthesizer-calculated",
      acceptedBandwidthHz: 4_799_998,
      bandwidthEvidence: "ad9361-readback",
      acceptedSampleRateHz: 4_800_000,
      sampleRateEvidence: "ddc-calculated",
    });
    expect(details.capabilities.fpga).toMatchObject({
      signature: 0xace0ba5e,
      compatibilityMajor: 7,
      compatibilityMinor: 3,
    });
    expect(details.observations).toEqual({
      ad9364DeviceIdVerified: true,
      rxPllLocked: true,
      timestampRateValidation: "pending",
    });

    const writes = decodedWrites(io);
    const tuples = writes.map(({ sid, address, value }) => [
      sid,
      address,
      value,
    ]);
    expect(tuples.slice(0, 9)).toEqual([
      [0x40, 32, 0],
      [0x40, 32, 2],
      [0x40, 16, 4],
      [0x40, 16, 0],
      [0x40, 8, 49],
      [0x40, 9, 0x98000001],
      [0x40, 10, 0x81234500],
      [0x40, 10, 0x00170000],
      [0x40, 32, 1],
    ]);
    expect(tuples.slice(9, 15)).toEqual([
      [0x10, 12, 0x48],
      [0x10, 13, 0x48],
      [0x10, 14, 0x48],
      [0x10, 15, 0x48],
      [0x10, 16, 0],
      [0x10, 17, 0],
    ]);
    expect(tuples).toContainEqual([0x40, 8, 49]);
    expect(tuples).toContainEqual([0x40, 9, 0x98000001]);
    expect(tuples).toContainEqual([0x10, 145, 0x9b57]);
    expect(tuples).toContainEqual([0x10, 146, 0x302]);
    expect(tuples).toContainEqual([0x10, 100, 4086]);
    expect(tuples).toContainEqual([0x10, 101, 0xa0]);
    expect(
      writes
        .filter(
          (entry) =>
            entry.sid === 0x10 && entry.address >= 12 && entry.address <= 15,
        )
        .every((entry) => (entry.value & 0x80) === 0),
    ).toBe(true);
    expect(
      writes.some(
        (entry) =>
          entry.sid === 0x10 && (entry.address === 138 || entry.address >= 184),
      ),
    ).toBe(false);
    expect(io.rxReads).toEqual([]);
    expect(closeOwner).not.toHaveBeenCalled();
    await control.close();
  });

  it("applies the initial LO through the same ALERT/LO/RX transition as a retune", async () => {
    const { closeOwner, control } = fixture();
    const events: string[] = [];
    const rf = driver({
      initializeRx: vi.fn(async (_spi, _profile, frequencyHz) => {
        events.push(`initialize:${frequencyHz}`);
      }),
      setRxClockPath: vi.fn(async () => {
        events.push("clock");
      }),
      setRxBandwidth: vi.fn(async () => {
        events.push("bandwidth");
      }),
      enterAlert: vi.fn(async () => {
        events.push("alert");
        return "ALERT" as const;
      }),
      setRxLo: vi.fn(async (frequencyHz) => {
        events.push(`lo:${frequencyHz}`);
        return { frequencyHz, rxPllLocked: true as const };
      }),
      selectRxInput: vi.fn(async () => {
        events.push("input");
      }),
      setRxGainMode: vi.fn(async () => {
        events.push("gain");
      }),
      enterRx: vi.fn(async () => {
        events.push("rx");
        return "RX" as const;
      }),
      readRxReport: vi.fn(async () => {
        events.push("report");
        return report(180_064_000);
      }),
    });
    const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
      closeOwner,
      pause: async () => undefined,
    });

    await configurator.initialize(
      createUsrpB205RequestedConfiguration(180_064_000),
    );

    expect(events).toEqual([
      "initialize:181064000",
      "clock",
      "bandwidth",
      "alert",
      "lo:180064000",
      "input",
      "gain",
      "rx",
      "report",
    ]);
    await control.close();
  });

  it("configures the 9.6 MS/s profile with 9.6 MHz RF bandwidth and FPGA decimation by four", async () => {
    const { io, closeOwner, control } = fixture();
    const rf = driver({
      readRxReport: vi.fn(async () => ({
        ...report(),
        rxBandwidthHz: 9_599_998,
      })),
    });
    const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
      closeOwner,
      pause: async () => undefined,
    });
    const details = await configurator.initialize(
      createUsrpB205RequestedConfiguration(5_800_000_001, 9_600_000),
    );
    expect(rf.setRxBandwidth).toHaveBeenCalledWith(9_600_000);
    expect(decodedWrites(io)).toContainEqual({
      sid: 0x10,
      address: 146,
      value: 0x301,
    });
    expect(decodedWrites(io)).toContainEqual({
      sid: 0x10,
      address: 145,
      value: 0x9b57,
    });
    expect(details).toMatchObject({
      nativeSampleRateHz: 9_600_000,
      effectiveSampleRateHz: 2_400_000,
      configuration: {
        requested: {
          requestedSampleRateHz: 9_600_000,
          requestedBandwidthHz: 9_600_000,
        },
        acceptedSampleRateHz: 9_600_000,
        acceptedBandwidthHz: 9_599_998,
      },
    });
    await control.close();
  });

  it("configures the experimental 19.2 MS/s profile with FPGA decimation by two", async () => {
    const { io, closeOwner, control } = fixture();
    const rf = driver({
      readRxReport: vi.fn(async () => ({
        ...report(),
        rxBandwidthHz: 19_199_998,
      })),
    });
    const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
      closeOwner,
      pause: async () => undefined,
    });
    const details = await configurator.initialize(
      createUsrpB205RequestedConfiguration(4_300_000_001, 19_200_000),
    );
    expect(rf.setRxBandwidth).toHaveBeenCalledWith(19_200_000);
    expect(decodedWrites(io)).toContainEqual({
      sid: 0x10,
      address: 146,
      value: 0x201,
    });
    expect(details).toMatchObject({
      nativeSampleRateHz: 19_200_000,
      configuration: {
        requested: {
          requestedSampleRateHz: 19_200_000,
          requestedBandwidthHz: 19_200_000,
        },
        acceptedSampleRateHz: 19_200_000,
        acceptedBandwidthHz: 19_199_998,
      },
    });
    await control.close();
  });

  it("is idempotent for the same accepted request and emits exact RX start/stop commands", async () => {
    const { io, closeOwner, control } = fixture();
    const rf = driver();
    const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
      closeOwner,
      pause: async () => undefined,
    });
    const requested = createUsrpB205RequestedConfiguration(5_800_000_001);
    const first = await configurator.initialize(requested);
    const count = io.writes.length;
    expect(await configurator.initialize(requested)).toEqual(first);
    expect(io.writes).toHaveLength(count);
    await configurator.startContinuous();
    await configurator.stopContinuous();
    expect(decodedWrites(io).slice(-10)).toEqual([
      { sid: 0x10, address: 96, value: 0xe0000001 },
      { sid: 0x10, address: 97, value: 0 },
      { sid: 0x10, address: 98, value: 0 },
      { sid: 0x10, address: 96, value: 0x90000000 },
      { sid: 0x10, address: 97, value: 0 },
      { sid: 0x10, address: 98, value: 0 },
      { sid: 0x10, address: 12, value: 0x48 },
      { sid: 0x10, address: 13, value: 0x48 },
      { sid: 0x10, address: 14, value: 0x48 },
      { sid: 0x10, address: 15, value: 0x48 },
    ]);
    await control.close();
  });

  it("makes retune a stop/invalidate/ALERT/LO/RX/reset/restart metadata boundary", async () => {
    const { closeOwner, control } = fixture();
    const events: string[] = [];
    const rf = driver({
      enterAlert: vi.fn(async () => {
        events.push("alert");
        return "ALERT" as const;
      }),
      setRxLo: vi.fn(async (frequencyHz) => {
        events.push(`lo:${frequencyHz}`);
        return { frequencyHz: frequencyHz - 1, rxPllLocked: true as const };
      }),
      enterRx: vi.fn(async () => {
        events.push("rx");
        return "RX" as const;
      }),
    });
    const boundary: UsrpB205RxBoundary = {
      stopAndDrain: async () => {
        events.push("stop-drain");
      },
      incrementGenerationAndDiscardOldPackets: () => {
        events.push("generation");
      },
      acceptSession: () => {
        events.push("accept-session");
      },
      resetExpectedRxSequence: () => {
        events.push("sequence-reset");
      },
      restart: async () => {
        events.push("restart");
      },
    };
    const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
      closeOwner,
      pause: async () => undefined,
    });
    await configurator.initialize(
      createUsrpB205RequestedConfiguration(5_800_000_001),
    );
    events.length = 0;
    const next = await configurator.retune(4_300_000_001, boundary);
    expect(events).toEqual([
      "stop-drain",
      "generation",
      "alert",
      "lo:4300000001",
      "rx",
      "accept-session",
      "sequence-reset",
      "restart",
    ]);
    expect(next.configuration).toMatchObject({
      requested: { requestedCenterFrequencyHz: 4_300_000_001 },
      acceptedCenterFrequencyHz: 4_300_000_000,
    });
    await control.close();
  });

  it("closes and requires a power cycle after partial RF initialization failure", async () => {
    const { closeOwner, control } = fixture();
    const failure = new Error("RFIC stage failed");
    const configurator = new UsrpB205RxConfigurator(
      identity,
      control,
      driver({
        initializeRx: vi.fn(async () => {
          throw failure;
        }),
      }),
      { closeOwner, pause: async () => undefined },
    );
    await expect(
      configurator.initialize(
        createUsrpB205RequestedConfiguration(100_000_000),
      ),
    ).rejects.toBe(failure);
    expect(configurator.diagnostics).toEqual({
      stage: "failed-power-cycle-required",
      rfStateUnknown: true,
      powerCycleRequired: true,
    });
    expect(closeOwner).toHaveBeenCalledOnce();
    await expect(
      configurator.initialize(
        createUsrpB205RequestedConfiguration(100_000_000),
      ),
    ).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it.each([
    [
      "clock path",
      {
        setRxClockPath: vi.fn(async () => {
          throw new Error("clock path");
        }),
      },
    ],
    [
      "bandwidth",
      {
        setRxBandwidth: vi.fn(async () => {
          throw new Error("bandwidth");
        }),
      },
    ],
    [
      "LO",
      {
        setRxLo: vi.fn(async () => {
          throw new Error("LO");
        }),
      },
    ],
    [
      "input",
      {
        selectRxInput: vi.fn(async () => {
          throw new Error("input");
        }),
      },
    ],
    [
      "gain",
      {
        setRxGainMode: vi.fn(async () => {
          throw new Error("gain");
        }),
      },
    ],
    [
      "ENSM",
      {
        enterRx: vi.fn(async () => {
          throw new Error("ENSM");
        }),
      },
    ],
    [
      "readback",
      {
        readRxReport: vi.fn(async () => {
          throw new Error("readback");
        }),
      },
    ],
  ] satisfies Array<[string, Partial<UsrpB205Ad9364Driver>]>)(
    "closes transactionally when the AD9364 %s stage fails",
    async (_name, override) => {
      const { closeOwner, control } = fixture();
      const configurator = new UsrpB205RxConfigurator(
        identity,
        control,
        driver(override),
        { closeOwner, pause: async () => undefined },
      );
      await expect(
        configurator.initialize(
          createUsrpB205RequestedConfiguration(100_000_000),
        ),
      ).rejects.toThrow();
      expect(configurator.diagnostics.powerCycleRequired).toBe(true);
      expect(closeOwner).toHaveBeenCalledOnce();
    },
  );

  it("rejects runtime drift from the frozen request before the first hardware command", async () => {
    const { io, closeOwner, control } = fixture();
    const invalid = {
      ...createUsrpB205RequestedConfiguration(100_000_000),
      requestedBandwidthHz: 1 as 4_800_000,
    };
    const configurator = new UsrpB205RxConfigurator(
      identity,
      control,
      driver(),
      { closeOwner, pause: async () => undefined },
    );
    await expect(configurator.initialize(invalid)).rejects.toThrow(
      /outside the frozen/,
    );
    expect(io.writes).toEqual([]);
    expect(closeOwner).not.toHaveBeenCalled();
  });

  it("rejects invalid FPGA/core/PLL or fabricated RF evidence and never publishes metadata", async () => {
    const cases: Array<
      (io: FakeUsrpB205ControlIo, rf: UsrpB205Ad9364Driver) => void
    > = [
      (io) => {
        const base = io.responseFor;
        io.responseFor = (request) => {
          const view = new DataView(
            request.buffer,
            request.byteOffset,
            request.byteLength,
          );
          return view.getUint32(8, true) === 32 &&
            view.getUint32(12, true) === 0
            ? encodeUsrpB205ControlAck(request, {
                readback: 0xdeadbeef00070000n,
              })
            : base(request);
        };
      },
      (io) => {
        const base = io.responseFor;
        io.responseFor = (request) => {
          const view = new DataView(
            request.buffer,
            request.byteOffset,
            request.byteLength,
          );
          return view.getUint32(8, true) === 32 &&
            view.getUint32(12, true) === 2
            ? encodeUsrpB205ControlAck(request, { readback: 0n })
            : base(request);
        };
      },
      (_io, rf) => {
        rf.readRxReport = vi.fn(async () => ({
          ...report(),
          ensmMode: "TX" as "RX",
        }));
      },
      (io) => {
        const base = io.responseFor;
        io.responseFor = (request) => {
          const view = new DataView(
            request.buffer,
            request.byteOffset,
            request.byteLength,
          );
          return view.getUint32(8, true) === 32 &&
            view.getUint32(12, true) === 3
            ? encodeUsrpB205ControlAck(request, { readback: 0n })
            : base(request);
        };
      },
    ];
    for (const alter of cases) {
      const { io, closeOwner, control } = fixture();
      const rf = driver();
      alter(io, rf);
      const configurator = new UsrpB205RxConfigurator(identity, control, rf, {
        closeOwner,
        pause: async () => undefined,
      });
      await expect(
        configurator.initialize(
          createUsrpB205RequestedConfiguration(5_800_000_001),
        ),
      ).rejects.toThrow();
      expect(closeOwner).toHaveBeenCalledOnce();
    }
  });
});
