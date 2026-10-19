'use strict';
// Framed PCM may arrive split at any byte boundary. Bound all allocations.
class PCMParser {
  constructor(onFrame) { this.buffer=Buffer.alloc(0); this.onFrame=onFrame; }
  push(chunk) {
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=16) {
      const magic=this.buffer.readUInt32LE(0), rate=this.buffer.readUInt32LE(4), frames=this.buffer.readUInt32LE(8);
      if(magic!==0x50434d31||frames<1||frames>2048||rate<8000||rate>384000)throw Error('Invalid native audio frame');
      const size=16+frames*8;if(this.buffer.length<size)break;
      this.onFrame({rate,sequence:this.buffer.readUInt32LE(12),pcm:this.buffer.subarray(16,size)});
      this.buffer=this.buffer.subarray(size);
    }
    if(this.buffer.length>16400)throw Error('Audio frame buffer overflow');
  }
}
module.exports={PCMParser};
