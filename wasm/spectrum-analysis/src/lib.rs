use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;

const FLOOR_DB: f32 = -120.0;

pub struct SpectrumAnalyzer {
    size: usize,
    windows_per_average: u32,
    averaged_windows: u32,
    input_i: Vec<f32>,
    input_q: Vec<f32>,
    fft_buffer: Vec<Complex32>,
    window: Vec<f32>,
    power_sum: Vec<f64>,
    output: Vec<f32>,
    normalization: f64,
    fft: Arc<dyn Fft<f32>>,
    scratch: Vec<Complex32>,
    batch_output: Vec<f32>,
}

impl SpectrumAnalyzer {
    fn new(size: usize, windows_per_average: u32) -> Option<Self> {
        if size < 2 || !size.is_power_of_two() || windows_per_average == 0 {
            return None;
        }
        let window: Vec<f32> = (0..size)
            .map(|index| {
                0.5 * (1.0
                    - ((2.0 * std::f32::consts::PI * index as f32) / (size - 1) as f32).cos())
            })
            .collect();
        let coherent_gain: f64 = window.iter().map(|value| *value as f64).sum();
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(size);
        Some(Self {
            size,
            windows_per_average,
            averaged_windows: 0,
            input_i: vec![0.0; size * 8],
            input_q: vec![0.0; size * 8],
            fft_buffer: vec![Complex32::new(0.0, 0.0); size],
            window,
            power_sum: vec![0.0; size],
            output: vec![FLOOR_DB; size],
            normalization: coherent_gain * coherent_gain,
            scratch: vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()],
            batch_output: vec![FLOOR_DB; size * 8],
            fft,
        })
    }

    fn reset(&mut self) {
        self.averaged_windows = 0;
        self.power_sum.fill(0.0);
    }

    fn process(&mut self, offset: usize) -> bool {
        for index in 0..self.size {
            let coefficient = self.window[index];
            self.fft_buffer[index] =
                Complex32::new(self.input_i[offset + index] * coefficient, self.input_q[offset + index] * coefficient);
        }
        self.fft.process_with_scratch(&mut self.fft_buffer, &mut self.scratch);
        for index in 0..self.size {
            let value = self.fft_buffer[index];
            self.power_sum[index] += (value.re as f64 * value.re as f64
                + value.im as f64 * value.im as f64);
        }
        self.averaged_windows += 1;
        if self.averaged_windows < self.windows_per_average {
            return false;
        }

        let half = self.size / 2;
        for shifted in 0..self.size {
            let source = (shifted + half) % self.size;
            let mean_power = self.power_sum[source] / (self.normalization * self.averaged_windows as f64);
            self.output[shifted] = (10.0 * mean_power.max(1e-12).log10())
                .max(FLOOR_DB as f64) as f32;
        }
        self.reset();
        true
    }
}

#[no_mangle]
pub extern "C" fn spectrum_create(size: u32, windows_per_average: u32) -> *mut SpectrumAnalyzer {
    SpectrumAnalyzer::new(size as usize, windows_per_average)
        .map(|analyzer| Box::into_raw(Box::new(analyzer)))
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn spectrum_destroy(analyzer: *mut SpectrumAnalyzer) {
    if !analyzer.is_null() {
        drop(Box::from_raw(analyzer));
    }
}

#[no_mangle]
pub unsafe extern "C" fn spectrum_reset(analyzer: *mut SpectrumAnalyzer) {
    if let Some(analyzer) = analyzer.as_mut() {
        analyzer.reset();
    }
}

#[no_mangle]
pub unsafe extern "C" fn spectrum_input_i(analyzer: *mut SpectrumAnalyzer) -> *mut f32 {
    analyzer.as_mut().map(|value| value.input_i.as_mut_ptr()).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn spectrum_input_q(analyzer: *mut SpectrumAnalyzer) -> *mut f32 {
    analyzer.as_mut().map(|value| value.input_q.as_mut_ptr()).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn spectrum_output(analyzer: *mut SpectrumAnalyzer) -> *const f32 {
    analyzer.as_ref().map(|value| value.output.as_ptr()).unwrap_or(std::ptr::null())
}

#[no_mangle]
pub unsafe extern "C" fn spectrum_process(analyzer: *mut SpectrumAnalyzer) -> u32 {
    analyzer.as_mut().map(|value| u32::from(value.process(0))).unwrap_or(0)
}

mod channel;

/// At most eight complete windows per call; bit n identifies output for window n.
#[no_mangle]
pub unsafe extern "C" fn spectrum_process_batch(analyzer: *mut SpectrumAnalyzer, windows: u32) -> u32 {
    if windows > 8 { return 0; }
    let Some(a) = analyzer.as_mut() else { return 0; };
    let mut mask = 0;
    for n in 0..windows as usize {
        if a.process(n * a.size) {
            a.batch_output[n*a.size..(n+1)*a.size].copy_from_slice(&a.output);
            mask |= 1 << n;
        }
    }
    mask
}
#[no_mangle]
pub unsafe extern "C" fn spectrum_batch_output(analyzer: *mut SpectrumAnalyzer) -> *const f32 {
    analyzer.as_ref().map(|a| a.batch_output.as_ptr()).unwrap_or(std::ptr::null())
}
