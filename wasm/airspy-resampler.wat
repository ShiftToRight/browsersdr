;; Bounded polyphase dot products, standard SIMD only. I/Q share coefficients.
;; Coefficients: 0..262143; input I/Q: 262144/524288; output I/Q: 786432/917504.
;; Caller validates phases <= 512, taps <= 128, input <= 32768+127,
;; and output <= 32768. Memory never grows. Padding coefficients are zero.
(module
  (memory (export "memory") 17 17)
  (func (export "process") (param $up i32) (param $down i32)
    (param $taps i32) (param $count i32) (param $skip i32)
    (local $n i32) (local $t i32) (local $position i32)
    (local $data i32) (local $coefs i32)
    (local $i v128) (local $q v128) (local $c v128)
    (local.set $position (local.get $skip))
    (block $done (loop $outputs
      (br_if $done (i32.ge_u (local.get $n) (local.get $count)))
      (local.set $data (i32.shl (i32.div_u (local.get $position) (local.get $up)) (i32.const 2)))
      (local.set $coefs (i32.shl (i32.mul (i32.rem_u (local.get $position) (local.get $up)) (local.get $taps)) (i32.const 2)))
      (local.set $i (v128.const f32x4 0 0 0 0))
      (local.set $q (v128.const f32x4 0 0 0 0))
      (local.set $t (i32.const 0))
      (loop $dot
        (local.set $c (v128.load (i32.add (local.get $coefs) (local.get $t))))
        (local.set $i (f32x4.add (local.get $i) (f32x4.mul (local.get $c)
          (v128.load offset=262144 (i32.add (local.get $data) (local.get $t))))))
        (local.set $q (f32x4.add (local.get $q) (f32x4.mul (local.get $c)
          (v128.load offset=524288 (i32.add (local.get $data) (local.get $t))))))
        (local.set $t (i32.add (local.get $t) (i32.const 16)))
        (br_if $dot (i32.lt_u (local.get $t) (i32.shl (local.get $taps) (i32.const 2)))))
      (f32.store offset=786432 (i32.shl (local.get $n) (i32.const 2))
        (f32.add (f32.add (f32x4.extract_lane 0 (local.get $i)) (f32x4.extract_lane 1 (local.get $i)))
          (f32.add (f32x4.extract_lane 2 (local.get $i)) (f32x4.extract_lane 3 (local.get $i)))))
      (f32.store offset=917504 (i32.shl (local.get $n) (i32.const 2))
        (f32.add (f32.add (f32x4.extract_lane 0 (local.get $q)) (f32x4.extract_lane 1 (local.get $q)))
          (f32.add (f32x4.extract_lane 2 (local.get $q)) (f32x4.extract_lane 3 (local.get $q)))))
      (local.set $position (i32.add (local.get $position) (local.get $down)))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $outputs)))
  )
)
