use std::arch::wasm32::{v128, f64x2, f64x2_add, f64x2_mul, f64x2_splat, f64x2_extract_lane};
const MAX: usize = 32768;
struct Stage {
    taps: [f64; 95], history: Vec<v128>,
    parity: bool, osc_i: f64, osc_q: f64,
    rot_i: f64, rot_q: f64, count: usize, mixing: bool,
}
impl Stage {
    fn new(size: usize, capacity: usize) -> Self {
        let mut stage = Self { taps: [0.; 95], history: vec![f64x2(0., 0.); capacity + size - 1],
            parity: false, osc_i: 1., osc_q: 0., rot_i: 1., rot_q: 0., count: 0, mixing: false };
        let middle = (size - 1) / 2;
        let mut sum = 0.;
        for n in 0..size {
            let x = n as i32 - middle as i32;
            let sinc = if x == 0 { 0.5 } else if x % 2 == 0 { 0. } else { (std::f64::consts::PI * 0.5 * x as f64).sin() / (std::f64::consts::PI * x as f64) };
            let window = 0.42 - 0.5 * (2. * std::f64::consts::PI * n as f64 / (size - 1) as f64).cos()
                + 0.08 * (4. * std::f64::consts::PI * n as f64 / (size - 1) as f64).cos();
            stage.taps[n] = sinc * window; sum += stage.taps[n];
        }
        for n in 0..size { stage.taps[n] /= sum; }
        stage
    }
    fn reset(&mut self, offset: f64, rate: f64) {
        self.history.fill(f64x2(0., 0.)); self.parity = false;
        self.osc_i = 1.; self.osc_q = 0.; self.count = 0; self.mixing = offset != 0.;
        self.rot_i = (-2. * std::f64::consts::PI * offset / rate).cos();
        self.rot_q = (-2. * std::f64::consts::PI * offset / rate).sin();
    }
    // Caller guarantees length <= both slices and the stage input capacity.
    // History holds N-1 carried samples followed by a complete input block.
    // Private stages use N=15/31/95; each convolution stays within length+N-1.
    unsafe fn process<const N: usize>(&mut self, i: &mut [f32], q: &mut [f32], length: usize) -> usize {
        let mut out = 0;
        for n in 0..length {
            let (mut re, mut im) = (*i.get_unchecked(n) as f64, *q.get_unchecked(n) as f64);
            if self.mixing {
                (re, im) = (re * self.osc_i - im * self.osc_q, re * self.osc_q + im * self.osc_i);
                (self.osc_i, self.osc_q) = (self.osc_i * self.rot_i - self.osc_q * self.rot_q, self.osc_i * self.rot_q + self.osc_q * self.rot_i);
                self.count += 1;
                if self.count == 4096 { let norm = self.osc_i.hypot(self.osc_q); self.osc_i /= norm; self.osc_q /= norm; self.count = 0; }
            }
            *self.history.get_unchecked_mut(n + N - 1) = f64x2(re, im);
        }
        // Separate input/mixing from the retained output phase: no ring cursor,
        // mirrored stores or parity branch in the native-rate hot loop.
        let first = if self.parity { 0 } else { 1 };
        self.parity ^= length % 2 != 0;
        for start in (first..length).step_by(2) {
            let middle = (N - 1) / 2;
            // I and Q share the same real FIR coefficients: evaluate both lanes together.
            let mut sum = f64x2(0., 0.);
            for t in (0..middle).step_by(2) {
                let a = start + t; let b = start + N - 1 - t;
                let pair = f64x2_add(*self.history.get_unchecked(a), *self.history.get_unchecked(b));
                sum = f64x2_add(sum, f64x2_mul(f64x2_splat(*self.taps.get_unchecked(t)), pair));
            }
            sum = f64x2_add(sum, f64x2_mul(f64x2_splat(*self.taps.get_unchecked(middle)), *self.history.get_unchecked(start + middle)));
            *i.get_unchecked_mut(out) = f64x2_extract_lane::<0>(sum) as f32;
            *q.get_unchecked_mut(out) = f64x2_extract_lane::<1>(sum) as f32;
            out += 1;
        }
        self.history.copy_within(length..length + N - 1, 0);
        out
    }
}
pub struct Channel { first: Stage, second: Option<Stage>, third: Option<Stage>, rate: f64, i: Vec<f32>, q: Vec<f32> }
#[no_mangle]
pub extern "C" fn channel_create() -> *mut Channel { channel_create_rate(9_600_000) }
#[no_mangle]
pub extern "C" fn channel_create_rate(rate: u32) -> *mut Channel {
    if rate != 4_800_000 && rate != 9_600_000 && rate != 19_200_000 { return std::ptr::null_mut(); }
    Box::into_raw(Box::new(Channel { first: Stage::new(if rate == 19_200_000 { 15 } else if rate == 9_600_000 { 31 } else { 95 }, MAX),
        second: if rate >= 9_600_000 { Some(Stage::new(if rate == 19_200_000 { 31 } else { 95 }, MAX / 2)) } else { None },
        third: if rate == 19_200_000 { Some(Stage::new(95, MAX / 4)) } else { None },
        rate: rate as f64, i: vec![0.; MAX], q: vec![0.; MAX] }))
}
#[no_mangle]
pub unsafe extern "C" fn channel_destroy(p: *mut Channel) { if !p.is_null() { drop(Box::from_raw(p)); } }
#[no_mangle]
pub unsafe extern "C" fn channel_reset(p: *mut Channel, offset: f64) -> u32 {
    if let Some(c) = p.as_mut() {
        if !offset.is_finite() || offset.abs() >= c.rate / 2. { return 0; }
        c.first.reset(offset, c.rate);
        if let Some(second) = c.second.as_mut() { second.reset(0., c.rate / 2.); }
        if let Some(third) = c.third.as_mut() { third.reset(0., 4_800_000.); }
        return 1;
    } 0
}
#[no_mangle]
pub unsafe extern "C" fn channel_input_i(p: *mut Channel) -> *mut f32 { (*p).i.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn channel_input_q(p: *mut Channel) -> *mut f32 { (*p).q.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn channel_process(p: *mut Channel, length: usize) -> usize {
    if length > MAX || p.is_null() { return 0; }
    let c = &mut *p;
    if c.rate == 19_200_000. {
        let count = c.first.process::<15>(&mut c.i, &mut c.q, length);
        let count = c.second.as_mut().unwrap().process::<31>(&mut c.i, &mut c.q, count);
        c.third.as_mut().unwrap().process::<95>(&mut c.i, &mut c.q, count)
    } else if c.rate == 9_600_000. {
        let count = c.first.process::<31>(&mut c.i, &mut c.q, length);
        c.second.as_mut().unwrap().process::<95>(&mut c.i, &mut c.q, count)
    } else { c.first.process::<95>(&mut c.i, &mut c.q, length) }
}
