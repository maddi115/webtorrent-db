// negentropy.js - Negentropy set reconciliation (protocol version 1, the method Nostr uses).
// Two peers compare short fingerprints of time ranges, split the ranges that differ,
// and swap ID lists only for small ranges, so they find what is missing with very little data.
// Items are { timestamp, id } with a 32-byte id. Our 16-byte link IDs are padded with zeros.

const PROTOCOL_VERSION = 0x61;
const ID_SIZE = 32;
const FINGERPRINT_SIZE = 16;
const BUCKETS = 16;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const MAX_MESSAGE_RANGES = 50000;

const MODE_SKIP = 0;
const MODE_FINGERPRINT = 1;
const MODE_ID_LIST = 2;

export function hexToId(hex) {
    const bytes = new Uint8Array(ID_SIZE);
    for (let index = 0; index < hex.length / 2 && index < ID_SIZE; index++) {
        bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

export function idToHex(bytes, length = 16) {
    return Array.from(bytes.subarray(0, length), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bytesToHex(bytes) {
    return idToHex(bytes, bytes.length);
}

export function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) throw new Error('Bad message');
    return Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16));
}

function compareBytes(a, b) {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

// Items sorted by time, then id. Built once per sync.
export class Storage {
    constructor(items) {
        this.items = items
            .map(({ timestamp, id }) => ({ timestamp, id: typeof id === 'string' ? hexToId(id) : id }))
            .sort((a, b) => a.timestamp - b.timestamp || compareBytes(a.id, b.id));
    }

    get size() {
        return this.items.length;
    }

    // The first index at or after the bound
    findLowerBound(begin, end, bound) {
        let low = begin;
        let high = end;
        while (low < high) {
            const middle = (low + high) >> 1;
            const item = this.items[middle];
            const before = item.timestamp < bound.timestamp
                || (item.timestamp === bound.timestamp && compareBytes(item.id, bound.id) < 0);
            if (before) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    // Sum of ids as 256-bit numbers, plus the count, hashed and cut to 16 bytes
    async fingerprint(begin, end) {
        const sum = new Uint8Array(ID_SIZE);
        for (let index = begin; index < end; index++) {
            const id = this.items[index].id;
            let carry = 0;
            for (let byte = 0; byte < ID_SIZE; byte++) {
                const total = sum[byte] + id[byte] + carry;
                sum[byte] = total & 0xff;
                carry = total >> 8;
            }
        }
        const input = concat([sum, encodeVarInt(end - begin)]);
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
        return hash.subarray(0, FINGERPRINT_SIZE);
    }
}

function concat(parts) {
    const total = parts.reduce((length, part) => length + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
        output.set(part, offset);
        offset += part.length;
    });
    return output;
}

function encodeVarInt(value) {
    if (value === 0) return new Uint8Array([0]);
    const bytes = [];
    let remaining = value;
    while (remaining > 0) {
        bytes.push(remaining % 128);
        remaining = Math.floor(remaining / 128);
    }
    bytes.reverse();
    for (let index = 0; index < bytes.length - 1; index++) bytes[index] |= 0x80;
    return new Uint8Array(bytes);
}

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.offset = 0;
    }

    get done() {
        return this.offset >= this.bytes.length;
    }

    take(count) {
        if (this.offset + count > this.bytes.length) throw new Error('Message ended early');
        const part = this.bytes.subarray(this.offset, this.offset + count);
        this.offset += count;
        return part;
    }

    varInt() {
        let value = 0;
        for (let index = 0; index < 9; index++) {
            const byte = this.take(1)[0];
            value = value * 128 + (byte & 0x7f);
            if (!(byte & 0x80)) return value;
        }
        throw new Error('Number too long');
    }
}

export class Negentropy {
    constructor(storage) {
        this.storage = storage;
        this.isInitiator = false;
    }

    // Starts a sync. Returns the first message to send.
    async initiate() {
        this.isInitiator = true;
        this.lastTimestampOut = 0;
        const output = [new Uint8Array([PROTOCOL_VERSION])];
        output.push(await this.splitRange(0, this.storage.size, { timestamp: MAX_TIMESTAMP, id: new Uint8Array(0) }));
        return concat(output);
    }

    // Handles a message. The starter learns which IDs it has that the other side lacks,
    // and which IDs it needs. Returns the reply, or null when the sync is finished.
    async reconcile(message) {
        const reader = new Reader(message);
        this.lastTimestampIn = 0;
        this.lastTimestampOut = 0;
        const haveIds = [];
        const needIds = [];
        if (reader.take(1)[0] !== PROTOCOL_VERSION) throw new Error('Unsupported sync version');

        const output = [new Uint8Array([PROTOCOL_VERSION])];
        let previousBound = { timestamp: 0, id: new Uint8Array(0) };
        let previousIndex = 0;
        let skip = false;
        let ranges = 0;

        const doSkip = () => {
            if (!skip) return;
            skip = false;
            output.push(this.encodeBound(previousBound), encodeVarInt(MODE_SKIP));
        };

        while (!reader.done) {
            if (++ranges > MAX_MESSAGE_RANGES) throw new Error('Too many ranges');
            const bound = this.decodeBound(reader);
            const mode = reader.varInt();
            const lower = previousIndex;
            const upper = this.storage.findLowerBound(previousIndex, this.storage.size, bound);

            if (mode === MODE_SKIP) {
                skip = true;
            } else if (mode === MODE_FINGERPRINT) {
                const theirs = reader.take(FINGERPRINT_SIZE);
                const ours = await this.storage.fingerprint(lower, upper);
                if (compareBytes(theirs, ours) !== 0) {
                    doSkip();
                    output.push(await this.splitRange(lower, upper, bound));
                } else {
                    skip = true;
                }
            } else if (mode === MODE_ID_LIST) {
                const count = reader.varInt();
                const theirIds = new Map();
                for (let index = 0; index < count; index++) {
                    const id = reader.take(ID_SIZE);
                    theirIds.set(bytesToHex(id), id);
                }
                for (let index = lower; index < upper; index++) {
                    const key = bytesToHex(this.storage.items[index].id);
                    if (theirIds.has(key)) theirIds.delete(key);
                    else if (this.isInitiator) haveIds.push(this.storage.items[index].id);
                }
                if (this.isInitiator) {
                    skip = true;
                    theirIds.forEach((id) => needIds.push(id));
                } else {
                    doSkip();
                    const ids = this.storage.items.slice(lower, upper).map((item) => item.id);
                    output.push(this.encodeBound(bound), encodeVarInt(MODE_ID_LIST), encodeVarInt(ids.length), ...ids);
                }
            } else {
                throw new Error('Unknown range mode');
            }

            previousIndex = upper;
            previousBound = bound;
        }

        const reply = concat(output);
        return {
            reply: this.isInitiator && reply.length === 1 ? null : reply,
            haveIds: haveIds.map((id) => idToHex(id)),
            needIds: needIds.map((id) => idToHex(id))
        };
    }

    async splitRange(lower, upper, upperBound) {
        const output = [];
        const count = upper - lower;

        if (count < BUCKETS * 2) {
            const ids = this.storage.items.slice(lower, upper).map((item) => item.id);
            output.push(this.encodeBound(upperBound), encodeVarInt(MODE_ID_LIST), encodeVarInt(count), ...ids);
            return concat(output);
        }

        const perBucket = Math.floor(count / BUCKETS);
        const withExtra = count % BUCKETS;
        let current = lower;
        for (let bucket = 0; bucket < BUCKETS; bucket++) {
            const size = perBucket + (bucket < withExtra ? 1 : 0);
            const fingerprint = await this.storage.fingerprint(current, current + size);
            current += size;
            const nextBound = current === upper
                ? upperBound
                : this.minimalBound(this.storage.items[current - 1], this.storage.items[current]);
            output.push(this.encodeBound(nextBound), encodeVarInt(MODE_FINGERPRINT), fingerprint);
        }
        return concat(output);
    }

    minimalBound(previous, current) {
        if (current.timestamp !== previous.timestamp) return { timestamp: current.timestamp, id: new Uint8Array(0) };
        let shared = 0;
        while (shared < ID_SIZE && previous.id[shared] === current.id[shared]) shared += 1;
        return { timestamp: current.timestamp, id: current.id.slice(0, shared + 1) };
    }

    encodeBound(bound) {
        let timestamp;
        if (bound.timestamp === MAX_TIMESTAMP) {
            timestamp = encodeVarInt(0);
        } else {
            timestamp = encodeVarInt(bound.timestamp - this.lastTimestampOut + 1);
            this.lastTimestampOut = bound.timestamp;
        }
        return concat([timestamp, encodeVarInt(bound.id.length), bound.id]);
    }

    decodeBound(reader) {
        const delta = reader.varInt();
        let timestamp;
        if (delta === 0) {
            timestamp = MAX_TIMESTAMP;
        } else {
            timestamp = this.lastTimestampIn + delta - 1;
            this.lastTimestampIn = timestamp;
        }
        const length = reader.varInt();
        if (length > ID_SIZE) throw new Error('Bound too long');
        return { timestamp, id: reader.take(length).slice() };
    }
}
