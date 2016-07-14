/**
 * Convert a Buffer into a Readable stream
 */
var stream  = require('stream');
var util    = require('util');

function BufferStream(source) {

    if (!Buffer.isBuffer(source)) {
        throw new Error('The source must be a buffer.');
    }

    // Super constructor
    stream.Readable.call(this);

    this._source = source;
    this._offset = 0;
    this._length = source.length;

    this.on('end', this._destroy.bind(this));
}

util.inherits(BufferStream, stream.Readable);

BufferStream.prototype._destroy = function () {
    this._source = null;
    this._offset = null;
    this._length = null;
};

BufferStream.prototype._read = function (size) {

    if (this._offset < this._length) {
        this.push(this._source.slice(this._offset, (this._offset + size)));
        this._offset += size;
    }

    // Once there is no more data, close the readable stream
    if (this._offset >= this._length) {
        this.push(null);
    }
};

module.exports = BufferStream;
