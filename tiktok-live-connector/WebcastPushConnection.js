import { WebcastClient } from "./client/WebcastClient.js";
import { SignConfig } from "./utils/SignatureProvider.js";

export default class WebcastPushConnection {
    constructor(uniqueId, options = {}) { this.client = new WebcastClient(uniqueId, options); }
    connect() { return this.client.connect(); }
    disconnect() { this.client.disconnect(); }
    on(ev, fn) { this.client.on(ev, fn); }
    removeAllListeners() { this.client.removeAllListeners(); }
}
export { SignConfig };
