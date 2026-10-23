;; Standard SIMD, fixed memory, caller-validated complete symmetric FIR.
;; Coefficients at 0 (max 95), input at 512 (max 32768+94), output at 132096.
;; Four consecutive outputs occupy the SIMD lanes. Tail samples stay exact-length.
;; Address and retained-phase gathers are inline so cold/baseline WASM execution
;; avoids helper-call overhead in the innermost loops. Arithmetic is unchanged.
;; The generator specializes these marked vector loops for common tap counts;
;; generic loops and scalar tails retain the same accumulation order.
(module
  (memory (export "memory") 5 5)

  (func (export "convolve") (param $taps i32) (param $count i32)
    (local $n i32) (local $t i32) (local $half i32)
    (local $sum v128) (local $scalar f32)
    (local.set $half (i32.shr_u (local.get $taps) (i32.const 1)))
    (block $vector_done
      (loop $vector
        (br_if $vector_done (i32.gt_u (i32.add (local.get $n) (i32.const 4)) (local.get $count)))
        (local.set $sum (v128.const f32x4 0 0 0 0))
        (if (i32.and (local.get $taps) (i32.const 1))
          (then (local.set $sum (f32x4.mul
            (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $n) (local.get $half)) (i32.const 2))))
            (v128.load32_splat (i32.shl (local.get $half) (i32.const 2)))))))
        ;; SPECIALIZE convolve:begin
        (local.set $t (i32.const 0))
        (block $pairs_done
          (loop $pairs
            (br_if $pairs_done (i32.ge_u (local.get $t) (local.get $half)))
            (local.set $sum (f32x4.add (local.get $sum) (f32x4.mul
              (f32x4.add
                (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $n) (local.get $t)) (i32.const 2))))
                (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $n) (i32.sub (i32.sub (local.get $taps) (i32.const 1)) (local.get $t))) (i32.const 2)))))
              (v128.load32_splat (i32.shl (local.get $t) (i32.const 2))))))
            (local.set $t (i32.add (local.get $t) (i32.const 1)))
            (br $pairs)))
        ;; SPECIALIZE convolve:end
        (v128.store (i32.add (i32.const 132096) (i32.shl (local.get $n) (i32.const 2))) (local.get $sum))
        (local.set $n (i32.add (local.get $n) (i32.const 4)))
        (br $vector)))
    (block $tail_done
      (loop $tail
        (br_if $tail_done (i32.ge_u (local.get $n) (local.get $count)))
        (local.set $scalar (f32.const 0))
        (if (i32.and (local.get $taps) (i32.const 1))
          (then (local.set $scalar (f32.mul
            (f32.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $n) (local.get $half)) (i32.const 2))))
            (f32.load (i32.shl (local.get $half) (i32.const 2)))))))
        (local.set $t (i32.const 0))
        (block $scalar_pairs_done
          (loop $scalar_pairs
            (br_if $scalar_pairs_done (i32.ge_u (local.get $t) (local.get $half)))
            (local.set $scalar (f32.add (local.get $scalar) (f32.mul
              (f32.add
                (f32.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $n) (local.get $t)) (i32.const 2))))
                (f32.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $n) (i32.sub (i32.sub (local.get $taps) (i32.const 1)) (local.get $t))) (i32.const 2)))))
              (f32.load (i32.shl (local.get $t) (i32.const 2))))))
            (local.set $t (i32.add (local.get $t) (i32.const 1)))
            (br $scalar_pairs)))
        (f32.store (i32.add (i32.const 132096) (i32.shl (local.get $n) (i32.const 2))) (local.get $scalar))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $tail))))

  ;; Gather the retained phase for four consecutive half-band outputs. The one
  ;; unused lane beyond the input end lies in fixed padding and is never selected.

  (func (export "halfband") (param $taps i32) (param $count i32) (param $skip i32)
    (local $n i32) (local $t i32) (local $half i32) (local $start i32)
    (local $sum v128) (local $scalar f32)
    (local.set $half (i32.shr_u (local.get $taps) (i32.const 1)))
    (block $vector_done
      (loop $vector
        (br_if $vector_done (i32.gt_u (i32.add (local.get $n) (i32.const 4)) (local.get $count)))
        (local.set $start (i32.add (local.get $skip) (i32.shl (local.get $n) (i32.const 1))))
        (local.set $sum (f32x4.mul
          (i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27 (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $start) (local.get $half)) (i32.const 2)))) (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (i32.add (local.get $start) (local.get $half)) (i32.const 4)) (i32.const 2)))))
          (v128.load32_splat (i32.shl (local.get $half) (i32.const 2)))))
        ;; SPECIALIZE halfband:begin
        (local.set $t (i32.const 0))
        (block $pairs_done
          (loop $pairs
            (br_if $pairs_done (i32.ge_u (local.get $t) (local.get $half)))
            (local.set $sum (f32x4.add (local.get $sum) (f32x4.mul
              (f32x4.add
                (i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27 (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $start) (local.get $t)) (i32.const 2)))) (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (i32.add (local.get $start) (local.get $t)) (i32.const 4)) (i32.const 2)))))
                (i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 24 25 26 27 (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $start) (i32.sub (i32.sub (local.get $taps) (i32.const 1)) (local.get $t))) (i32.const 2)))) (v128.load (i32.add (i32.const 512) (i32.shl (i32.add (i32.add (local.get $start) (i32.sub (i32.sub (local.get $taps) (i32.const 1)) (local.get $t))) (i32.const 4)) (i32.const 2))))))
              (v128.load32_splat (i32.shl (local.get $t) (i32.const 2))))))
            (local.set $t (i32.add (local.get $t) (i32.const 2)))
            (br $pairs)))
        ;; SPECIALIZE halfband:end
        (v128.store (i32.add (i32.const 132096) (i32.shl (local.get $n) (i32.const 2))) (local.get $sum))
        (local.set $n (i32.add (local.get $n) (i32.const 4)))
        (br $vector)))
    (block $tail_done
      (loop $tail
        (br_if $tail_done (i32.ge_u (local.get $n) (local.get $count)))
        (local.set $start (i32.add (local.get $skip) (i32.shl (local.get $n) (i32.const 1))))
        (local.set $scalar (f32.mul
          (f32.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $start) (local.get $half)) (i32.const 2))))
          (f32.load (i32.shl (local.get $half) (i32.const 2)))))
        (local.set $t (i32.const 0))
        (block $pairs_done
          (loop $pairs
            (br_if $pairs_done (i32.ge_u (local.get $t) (local.get $half)))
            (local.set $scalar (f32.add (local.get $scalar) (f32.mul
              (f32.add
                (f32.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $start) (local.get $t)) (i32.const 2))))
                (f32.load (i32.add (i32.const 512) (i32.shl (i32.add (local.get $start) (i32.sub (i32.sub (local.get $taps) (i32.const 1)) (local.get $t))) (i32.const 2)))))
              (f32.load (i32.shl (local.get $t) (i32.const 2))))))
            (local.set $t (i32.add (local.get $t) (i32.const 2)))
            (br $pairs)))
        (f32.store (i32.add (i32.const 132096) (i32.shl (local.get $n) (i32.const 2))) (local.get $scalar))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $tail))))
)
