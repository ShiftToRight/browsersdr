const MAX: usize = 32768;
struct Stage {
    taps: [f64; 95], i: [f64; 190], q: [f64; 190], size: usize,
    cursor: usize, parity: bool, osc_i: f64, osc_q: f64,
    rot_i: f64, rot_q: f64, count: usize, mixing: bool,
}
impl Stage {
    fn new(size: usize) -> Self {
        let mut stage = Self { taps: [0.; 95], i: [0.; 190], q: [0.; 190], size,
            cursor: 0, parity: false, osc_i: 1., osc_q: 0., rot_i: 1., rot_q: 0., count: 0, mixing: false };
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
        self.i.fill(0.); self.q.fill(0.); self.cursor = 0; self.parity = false;
        self.osc_i = 1.; self.osc_q = 0.; self.count = 0; self.mixing = offset != 0.;
        self.rot_i = (-2. * std::f64::consts::PI * offset / rate).cos();
        self.rot_q = (-2. * std::f64::consts::PI * offset / rate).sin();
    }
    fn process(&mut self, i: &mut [f32], q: &mut [f32], length: usize) -> usize {
        let mut out = 0;
        for n in 0..length {
            let (mut re, mut im) = (i[n] as f64, q[n] as f64);
            if self.mixing {
                (re, im) = (re * self.osc_i - im * self.osc_q, re * self.osc_q + im * self.osc_i);
                (self.osc_i, self.osc_q) = (self.osc_i * self.rot_i - self.osc_q * self.rot_q, self.osc_i * self.rot_q + self.osc_q * self.rot_i);
                self.count += 1;
                if self.count == 4096 { let norm = self.osc_i.hypot(self.osc_q); self.osc_i /= norm; self.osc_q /= norm; self.count = 0; }
            }
            let c = self.cursor; self.i[c] = re; self.i[c + self.size] = re; self.q[c] = im; self.q[c + self.size] = im;
            self.cursor = if c + 1 == self.size { 0 } else { c + 1 };
            self.parity = !self.parity; if self.parity { continue; }
            let middle = (self.size - 1) / 2;
            let (mut re, mut im) = (0., 0.);
            for t in (0..middle).step_by(2) {
                let a = self.cursor + t; let b = self.cursor + self.size - 1 - t;
                re += self.taps[t] * (self.i[a] + self.i[b]); im += self.taps[t] * (self.q[a] + self.q[b]);
            }
            i[out] = (re + self.taps[middle] * self.i[self.cursor + middle]) as f32;
            q[out] = (im + self.taps[middle] * self.q[self.cursor + middle]) as f32;
            out += 1;
        }
        out
    }
}
pub struct Channel { first: Stage, second: Stage, i: Vec<f32>, q: Vec<f32> }
#[no_mangle]
pub extern "C" fn channel_create() -> *mut Channel {
    Box::into_raw(Box::new(Channel { first: Stage::new(31), second: Stage::new(95), i: vec![0.; MAX], q: vec![0.; MAX] }))
}
#[no_mangle]
pub unsafe extern "C" fn channel_destroy(p: *mut Channel) { if !p.is_null() { drop(Box::from_raw(p)); } }
#[no_mangle]
pub unsafe extern "C" fn channel_reset(p: *mut Channel, offset: f64) -> u32 {
    if !offset.is_finite() || offset.abs() >= 4_800_000. { return 0; }
    if let Some(c) = p.as_mut() { c.first.reset(offset, 9_600_000.); c.second.reset(0., 4_800_000.); return 1; } 0
}
#[no_mangle]
pub unsafe extern "C" fn channel_input_i(p: *mut Channel) -> *mut f32 { (*p).i.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn channel_input_q(p: *mut Channel) -> *mut f32 { (*p).q.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn channel_process(p: *mut Channel, length: usize) -> usize {
    if length > MAX || p.is_null() { return 0; }
    let c = &mut *p;
    let count = c.first.process(&mut c.i, &mut c.q, length);
    c.second.process(&mut c.i, &mut c.q, count)
}
