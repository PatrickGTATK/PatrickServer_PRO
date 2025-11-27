import { fetchRoomId, fetchWebcastData } from "./webcastRequests.js";
export default class WebcastClient {
 constructor(u,o){this.uniqueId=u;this.options=o;this.roomId=null;this.connected=false;
 this.lastMessageId="0";this.lastServerTime=0;this.eventCallback=null;this.stopPolling=false;}
 async connect(){const r=await fetchRoomId(this.uniqueId);if(!r.roomId)throw new Error("RoomID não encontrado");
 this.roomId=r.roomId;this.connected=true;this.startPolling();return r;}disconnect(){this.connected=false;this.stopPolling=true;}
 onEvent(cb){this.eventCallback=cb;}
 async startPolling(){while(!this.stopPolling){try{const d=await fetchWebcastData(this.roomId,this.lastMessageId,this.options.requestPolling);
 if(d&&d.messages){for(const m of d.messages){this.lastMessageId=m.id;this.lastServerTime=m.timestamp;if(this.eventCallback)this.eventCallback(m.type,m);}}}
 catch(e){console.error("Polling error:",e);}await new Promise(r=>setTimeout(r,this.options.fetchIntervalMs));}}}