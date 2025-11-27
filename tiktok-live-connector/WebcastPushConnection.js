import WebcastClient from "./client/WebcastClient.js";
import { applyViewerCountPatch } from "./utils/viewerPatch.js";
export default class WebcastPushConnection {
 constructor(u,o={}){this.uniqueId=u;this.options={fetchIntervalMs:1000,requestPolling:false,...o};
 this.client=new WebcastClient(u,this.options);this.eventHandlers=new Map();this.connected=false;applyViewerCountPatch();}
 async connect(){if(this.connected)return;const r=await this.client.connect();this.connected=true;
 this.client.onEvent((e,d)=>this.emit(e,d));return r;}disconnect(){this.connected=false;this.client.disconnect();}
 on(e,h){if(!this.eventHandlers.has(e))this.eventHandlers.set(e,new Set());this.eventHandlers.get(e).add(h);}
 removeAllListeners(){this.eventHandlers.clear();}emit(e,d){const hs=this.eventHandlers.get(e);if(!hs)return;
 for(const fn of hs){try{fn(d);}catch(err){console.error(err);}}} }