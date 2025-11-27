import { defaultHeaders } from "../utils/defaultHeaders.js";
const API_BASE="https://webcast.tiktok.com/webcast";
export async function fetchRoomId(u){
 const res=await fetch(`${API_BASE}/roomid/?uniqueId=${encodeURIComponent(u)}`,{headers:defaultHeaders});
 const j=await res.json();return{roomId:j?.data?.roomId??null,raw:j};}
export async function fetchWebcastData(id,last="0",poll=false){
 const p=new URLSearchParams({room_id:id,cursor:last,version:"1.0",compress:"gzip"});
 if(poll)p.append("is_polling","1");
 const res=await fetch(`${API_BASE}/im/fetch/?${p.toString()}`,{headers:defaultHeaders});
 const j=await res.json();return{messages:j?.data?.messages??[],raw:j};}