import { EventEmitter } from "events";

export class WebcastClient extends EventEmitter {
    constructor(uniqueId, options = {}) {
        super();
        this.uniqueId = uniqueId;
        this.options = options;
    }
    async connect(){
        return { roomId: "1234567890000" };
    }
    disconnect(){
        this.emit("disconnected");
    }
}
