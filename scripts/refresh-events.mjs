/*
 * Weekly collector for Rheinplan.
 * It only accepts public JSON-LD Event data and the authorised Ticketmaster API.
 * Human-reviewed seed entries stay in place; the collector adds new listings.
 */
import { readFile, writeFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(new URL('../events.json', import.meta.url)));
const sources = JSON.parse(await readFile(new URL('../sources.json', import.meta.url)));
const start = new Date(); start.setHours(0,0,0,0);
const end = new Date(start); end.setDate(end.getDate() + 60);
const toLocal = value => new Date(value).toISOString().slice(0,16);
const slug = value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const cityFor = (text, fallback) => /mannheim/i.test(text) ? 'mannheim' : /heidelberg/i.test(text) ? 'heidelberg' : fallback;
const categoryFor = text => /concert|music|jazz|musik/i.test(text) ? 'music' : /food|wein|wine|market/i.test(text) ? 'food' : /walk|nature|wander|outdoor/i.test(text) ? 'outdoors' : /theater|theatre|museum|film|art|ausstellung/i.test(text) ? 'culture' : 'community';
const stripHtml = value => (value || '').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
function flattenLd(value){
  if(Array.isArray(value)) return value.flatMap(flattenLd);
  if(!value || typeof value !== 'object') return [];
  return [...(value['@graph'] ? flattenLd(value['@graph']) : []), value];
}
function eventFromLd(item, source){
  const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
  if(!types.includes('Event') || !item.name || !item.startDate) return null;
  const starts = new Date(item.startDate), ends = new Date(item.endDate || item.startDate);
  if(Number.isNaN(+starts) || starts > end || ends < start) return null;
  const place = typeof item.location === 'object' ? (item.location.name || item.location.address?.addressLocality || '') : (item.location || 'Venue to be confirmed');
  const city = cityFor(`${place} ${item.name}`, source.city);
  return { id: `auto-${city}-${slug(item.name)}-${toLocal(starts).slice(0,10)}`, title: item.name.trim(), city, category: categoryFor(`${item.name} ${item.description||''}`), start:toLocal(starts), end:toLocal(ends), venue:place, description:stripHtml(item.description||`Event listed by ${source.name}.`).slice(0,400), source:item.url || source.url, sourceName:source.name };
}
function germanDate(value){
  const match = String(value || '').match(/(\d{2})\.(\d{2})\.(\d{4})/); if(!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}
function germanTimes(value){
  const matches = String(value || '').match(/\d{1,2}:\d{2}/g) || [];
  if(!matches.length) return {start:'00:00',end:'23:59',allDay:true};
  const clock = raw => raw.padStart(5,'0');
  return {start:clock(matches[0]),end:clock(matches[1] || matches[0]),allDay:false};
}
async function collectHeidelbergCalendar(source){
  const endpoint = 'https://www.heidelberg.de/site/Heidelberg2021/VXC/833798/loadData/loadData.json';
  const deDate = value => `${String(value.getDate()).padStart(2,'0')}.${String(value.getMonth()+1).padStart(2,'0')}.${value.getFullYear()}`;
  const from = deDate(start), to = deDate(end);
  const found=[];
  for(let offset=0;offset<2500;offset+=100){
    const params = new URLSearchParams({action:'pre','q.z.von':from,'q.z.bis':to,HKAT:'true',SORT:'200',dateformat:'XDATE',anz:'100',xstart:String(offset)});
    const response = await fetch(`${endpoint}?${params}`, {headers:{'user-agent':'Rheinplan weekly event collector/1.0 (+calendar source link)'}});
    if(!response.ok) throw new Error(`${response.status} Heidelberg calendar endpoint`);
    const rows = await response.json(); if(!Array.isArray(rows) || !rows.length) break;
    for(const row of rows){
      const day=germanDate(row.von); if(!day || !row.titel) continue;
      const clock=germanTimes(row.zeit), category=Array.isArray(row.kategorie) ? row.kategorie.map(item=>item.name).join(' ') : (row.kat||[]).join(' ');
      found.push({id:`heidelberg-${row.id}`,title:stripHtml(row.titel),city:'heidelberg',category:categoryFor(`${category} ${row.titel}`),start:`${day}T${clock.start}`,end:`${day}T${clock.end}`,allDay:clock.allDay||undefined,venue:row.location || 'Venue to be confirmed',description:stripHtml(row.beschreibung || `Official Heidelberg calendar listing from ${row.org || 'the organiser'}.`).slice(0,400),source:row.link_url || source.url,sourceName:source.name,officialEventId:String(row.id)});
    }
    if(rows.length<100) break;
  }
  return found;
}
async function collectJsonLd(source){
  const response = await fetch(source.url, {headers:{'user-agent':'Rheinplan weekly event collector/1.0 (+calendar source link)'}});
  if(!response.ok) throw new Error(`${response.status} ${source.url}`);
  const html = await response.text(), events=[];
  for(const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try { for(const item of flattenLd(JSON.parse(match[1]))) { const event=eventFromLd(item,source); if(event) events.push(event) } } catch { /* Invalid JSON-LD should not stop the weekly job. */ }
  }
  return events;
}
async function collectTicketmaster(){
  if(!process.env.TICKETMASTER_API_KEY) return [];
  const found=[];
  for(const [city,latlong] of Object.entries({heidelberg:'49.3988,8.6724',mannheim:'49.4875,8.4660'})){
    const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    url.search = new URLSearchParams({apikey:process.env.TICKETMASTER_API_KEY,latlong,radius:'30',unit:'km',startDateTime:start.toISOString().replace(/\.\d{3}Z$/,'Z'),endDateTime:end.toISOString().replace(/\.\d{3}Z$/,'Z'),size:'100'});
    const response=await fetch(url); if(!response.ok) continue;
    for(const item of (await response.json())._embedded?.events || []){
      const localDate=item.dates?.start?.localDate, localTime=item.dates?.start?.localTime || '00:00:00'; if(!localDate) continue;
      found.push({id:`ticketmaster-${item.id}`,title:item.name,city:cityFor(`${item._embedded?.venues?.[0]?.city?.name||''} ${item.name}`,city),category:categoryFor(`${item.name} ${item.classifications?.[0]?.segment?.name||''}`),start:`${localDate}T${localTime.slice(0,5)}`,end:`${localDate}T23:00`,venue:item._embedded?.venues?.[0]?.name||'Venue to be confirmed',description:'Imported from the authorised Ticketmaster Discovery API.',source:item.url,sourceName:'Ticketmaster'});
    }
  } return found;
}
const structuredSources=sources.filter(source=>source.kind!=='heidelberg-calendar');
const settled = await Promise.allSettled([...structuredSources.map(collectJsonLd), ...sources.filter(source=>source.kind==='heidelberg-calendar').map(collectHeidelbergCalendar)]);
for(const result of settled) if(result.status==='rejected') console.warn(`Source skipped: ${result.reason.message}`);
const publicEvents = settled.flatMap(result => result.status==='fulfilled' ? result.value : []);
const imported = [...publicEvents, ...(await collectTicketmaster())];
const ids = new Set(data.events.map(event=>event.id));
const eventKey = event => `${event.city}|${event.title.trim().toLowerCase()}|${event.start}`;
const eventKeys = new Set(data.events.map(eventKey));
for(const event of imported) if(!ids.has(event.id) && !eventKeys.has(eventKey(event))) { data.events.push(event); ids.add(event.id); eventKeys.add(eventKey(event)) }
data.events = data.events.filter(event => new Date(event.end) >= start && new Date(event.start) <= end).sort((a,b)=>new Date(a.start)-new Date(b.start));
data.generatedAt = new Date().toISOString(); data.window = {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
await writeFile(new URL('../events.json', import.meta.url), `${JSON.stringify(data,null,2)}\n`);
console.log(`Saved ${data.events.length} current listings (${imported.length} imported candidates).`);
