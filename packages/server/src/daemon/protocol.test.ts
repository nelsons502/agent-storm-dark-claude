import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    encodeControlFrame,
    encodeDataFrame,
    FrameDecodeError,
    FrameDecoder,
    FrameType,
} from './protocol.js';

describe(FrameDecoder.name, () => {
    it('decodes a whole frame', () => {
        const decoder = new FrameDecoder();
        const frames = decoder.push(encodeDataFrame('hello'));
        assert.strictEquals(frames.length, 1);
        assert.strictEquals(frames[0]?.type, FrameType.Data);
        assert.strictEquals(frames[0].payload.toString('utf-8'), 'hello');
    });

    it('emits nothing until a frame is complete, then emits it', () => {
        const decoder = new FrameDecoder();
        const encoded = encodeDataFrame('split across chunks');
        assert.deepEquals(decoder.push(encoded.subarray(0, 4)), []);
        const frames = decoder.push(encoded.subarray(4));
        assert.strictEquals(frames.length, 1);
        assert.strictEquals(frames[0]?.payload.toString('utf-8'), 'split across chunks');
    });

    it('decodes several frames arriving in one chunk', () => {
        const decoder = new FrameDecoder();
        const frames = decoder.push(
            Buffer.concat([
                encodeDataFrame('one'),
                encodeControlFrame({
                    hello: true,
                }),
                encodeDataFrame('two'),
            ]),
        );
        assert.strictEquals(frames.length, 3);
        assert.deepEquals(
            frames.map((frame) => frame.type),
            [
                FrameType.Data,
                FrameType.Control,
                FrameType.Data,
            ],
        );
    });

    it('throws rather than buffering a frame that declares an implausible length', () => {
        const decoder = new FrameDecoder();
        /**
         * A desynced stream can announce up to 4GB. Without the cap the decoder would hold every
         * byte that followed while waiting for a frame that never completes — the leak this
         * guards.
         */
        const bogus = Buffer.alloc(5);
        bogus.writeUInt8(FrameType.Data, 0);
        bogus.writeUInt32BE(4_000_000_000, 1);
        assert.throws(() => decoder.push(bogus), {
            matchConstructor: FrameDecodeError,
        });
    });

    it('drops its buffer when it rejects a frame, retaining nothing', () => {
        const decoder = new FrameDecoder();
        const bogus = Buffer.alloc(5);
        bogus.writeUInt8(FrameType.Data, 0);
        bogus.writeUInt32BE(4_000_000_000, 1);
        assert.throws(() => decoder.push(bogus));
        /**
         * The rejected header must not still be sitting in the buffer: if it were, the next push
         * would re-parse it and throw forever on otherwise-valid data.
         */
        const frames = decoder.push(encodeDataFrame('after'));
        assert.strictEquals(frames.length, 1);
        assert.strictEquals(frames[0]?.payload.toString('utf-8'), 'after');
    });

    it('accepts a frame at a plausible large size', () => {
        const decoder = new FrameDecoder();
        const payload = 'x'.repeat(200_000);
        const frames = decoder.push(encodeDataFrame(payload));
        assert.strictEquals(frames[0]?.payload.toString('utf-8').length, payload.length);
    });
});
