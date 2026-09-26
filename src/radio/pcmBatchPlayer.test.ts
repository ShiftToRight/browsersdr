import { expect, it, vi } from "vitest";
import { PcmBatchPlayer } from "./pcmBatchPlayer";
function setup() {
 const blocks: { left: number[]; right: number[] }[] = [];
 const output = { sampleRate: 48_000, setVolume: vi.fn(), getVolume: () => .5,
   play: (left: Float32Array, right: Float32Array) => blocks.push({ left: [...left], right: [...right] }) };
 return { player: new PcmBatchPlayer(output), blocks, output };
}
it("preserves ordered stereo PCM across odd chunks and flushes the final tail", () => {
 const { player, blocks } = setup(); player.configure(true);
 const left = Float32Array.from({length: 4097}, (_, n) => n / 8192), right = Float32Array.from(left, n => -n);
 for (let n = 0; n < left.length; n += 81) player.play(left.subarray(n, n + 81), right.subarray(n, n + 81));
 expect(blocks.map(b => b.left.length)).toEqual([1024,1024,1024,1024]);
 player.flush();
 expect(blocks.flatMap(b => b.left)).toEqual([...left]);
 expect(blocks.flatMap(b => b.right)).toEqual([...right]);
 player.flush(); expect(blocks).toHaveLength(5);
});
it("discards partial history at discontinuities and preserves legacy bypass and volume", () => {
 const { player, blocks, output } = setup(); player.configure(true);
 player.play(new Float32Array(100).fill(1), new Float32Array(100).fill(1));
 player.reset(); player.play(new Float32Array(1024), new Float32Array(1024));
 expect(blocks[0]!.left.every(n => n === 0)).toBe(true);
 player.configure(false); player.play(Float32Array.of(.2), Float32Array.of(-.2));
 expect(blocks[1]!.left).toHaveLength(1);
 player.setVolume(.7); expect(output.setVolume).toHaveBeenCalledWith(.7);
 expect(player.getVolume()).toBe(.5); expect(player.sampleRate).toBe(48000);
 expect(() => player.play(new Float32Array(1), new Float32Array(2))).toThrow();
});
