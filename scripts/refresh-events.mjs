/*
 * Daily collector for Rheinplan.
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
const categoryFor = text => /kino|cinema|film|movie|screening|vorf[uü]hrung/i.test(text) ? 'film' : /concert|music|jazz|musik/i.test(text) ? 'music' : /party|club|dj\b|disco|rave|nachtleben|nightlife/i.test(text) ? 'nightlife' : /sport|adler mannheim|rhein-neckar l[oö]wen|\bdel\b|\bhbl\b|\bchl\b|eishockey|handball|basketball|lauf|running|fitness/i.test(text) ? 'sports' : /buch|book|literatur|lesung|reading|lecture|vortrag|talk|colloqu|workshop|seminar|university|universit[aä]t|wissenschaft/i.test(text) ? 'learning' : /food|wein|wine|market/i.test(text) ? 'food' : /walk|nature|wander|outdoor/i.test(text) ? 'outdoors' : /theater|theatre|museum|art|ausstellung|tanz/i.test(text) ? 'culture' : 'community';
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
  const offer=Array.isArray(item.offers) ? item.offers.find(value=>value?.price!==undefined) : item.offers;
  const numericPrice=offer?.price===undefined ? null : Number(String(offer.price).replace(',','.'));
  const rawAge=String(item.typicalAgeRange || item.contentRating || '');
  const age=rawAge.match(/(?:fsk\s*)?(\d{1,2})\s*\+?/i)?.[1];
  const language=typeof item.inLanguage==='string' ? item.inLanguage : item.inLanguage?.name;
  return { id: `auto-${city}-${slug(item.name)}-${toLocal(starts).slice(0,10)}`, title: item.name.trim(), city, category: categoryFor(`${item.name} ${item.description||''}`), start:toLocal(starts), end:toLocal(ends), venue:place, description:stripHtml(item.description||`Event listed by ${source.name}.`).slice(0,400), source:item.url || source.url, sourceName:source.name, sourceIsGeneral:!item.url, language, ageMin:age?Number(age):undefined, ageLabel:age?`${age}+`:undefined, priceType:numericPrice===0?'free':numericPrice!==null?'paid':undefined, priceText:numericPrice===0?'Free admission':numericPrice!==null?`${offer.priceCurrency||'€'} ${offer.price}`:undefined };
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
      found.push({id:`heidelberg-${row.id}`,title:stripHtml(row.titel),city:'heidelberg',category:categoryFor(`${category} ${row.titel}`),start:`${day}T${clock.start}`,end:`${day}T${clock.end}`,allDay:clock.allDay||undefined,venue:row.location || 'Venue to be confirmed',description:stripHtml(row.beschreibung || `Official Heidelberg calendar listing from ${row.org || 'the organiser'}.`).slice(0,400),source:row.link_url || source.url,sourceName:source.name,sourceIsGeneral:!row.link_url,officialEventId:String(row.id)});
    }
    if(rows.length<100) break;
  }
  return found;
}
async function collectMannheimCalendar(source){
  const deDate=value=>`${String(value.getDate()).padStart(2,'0')}.${String(value.getMonth()+1).padStart(2,'0')}.${value.getFullYear()}`;
  const pageUrl=page=>{const url=new URL(source.url);url.search=new URLSearchParams({date_from:deDate(start),date_to:deDate(end),page:String(page)});return url};
  const parsePage=html=>{
    const found=[];
    const cards=html.split(/<li class=["']teaser-list__item["'][^>]*>/i).slice(1);
    for(const card of cards){
      const titleLink=card.match(/<h3>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const date=card.match(/icon-calendar[\s\S]*?<\/svg>\s*([^<]+)/i)?.[1]?.trim();
      if(!titleLink || !date) continue;
      const day=germanDate(date); if(!day) continue;
      const clock=card.match(/icon-clock[\s\S]*?<\/svg>\s*([^<]+)/i)?.[1]?.trim();
      const time=clock&&/^\d{1,2}:\d{2}$/.test(clock)?clock:'00:00';
      const begins=new Date(`${day}T${time.padStart(5,'0')}`); if(begins<start||begins>end) continue;
      const title=stripHtml(titleLink[2]), venue=stripHtml(card.match(/class=["']organization["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]||'Mannheim venue'), description=stripHtml(card.match(/class=["']teaser__text["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]||`Official Mannheim calendar listing at ${venue}.`);
      found.push({id:`mannheim-calendar-${slug(title)}-${day}-${time.replace(':','')}`,title,city:'mannheim',category:categoryFor(`${title} ${description}`),start:toLocal(begins),end:clock?toLocal(new Date(+begins+120*60*1000)):`${day}T23:59`,allDay:!clock||undefined,approximateEnd:!!clock,venue,description:description.slice(0,400),source:new URL(titleLink[1],source.url).href,sourceName:source.name});
    }
    return found;
  };
  const firstResponse=await fetch(pageUrl(0),{headers:{'user-agent':'Rheinplan daily event collector/1.0 (+calendar source link)'}});
  if(!firstResponse.ok) throw new Error(`${firstResponse.status} Mannheim calendar`);
  const firstHtml=await firstResponse.text(), found=parsePage(firstHtml);
  const total=Number(firstHtml.match(/Ergebnisse\s+\d+\s*-\s*\d+\s+von\s+(\d+)/i)?.[1]||0), pages=Math.min(Math.ceil(total/10),source.maxPages||250);
  for(let offset=1;offset<pages;offset+=4){
    const batch=await Promise.all(Array.from({length:Math.min(4,pages-offset)},async(_,index)=>{
      const response=await fetch(pageUrl(offset+index),{headers:{'user-agent':'Rheinplan daily event collector/1.0 (+calendar source link)'}});
      if(!response.ok) throw new Error(`${response.status} Mannheim calendar page ${offset+index}`);
      return parsePage(await response.text());
    }));
    found.push(...batch.flat());
  }
  return found;
}
async function collectKarlstorkino(source){
  const response=await fetch(source.url,{headers:{'user-agent':'Rheinplan weekly event collector/1.0 (+calendar source link)'}});
  if(!response.ok) throw new Error(`${response.status} Karlstorkino`);
  const html=await response.text(), found=[], currentYear=start.getFullYear();
  const pattern=/(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s*(\d{1,2})\.(\d{1,2})\.?\s*\/?\s*(\d{1,2}:\d{2})\s*Uhr\s*\/([\s\S]*?)(?=(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s*\d{1,2}\.\d{1,2}\.?\s*\/|$)/gi;
  for(const match of html.matchAll(pattern)){
    let year=currentYear, date=new Date(year,Number(match[2])-1,Number(match[1]),12); if(date<new Date(start.getFullYear(),start.getMonth()-1,1)) { year++; date=new Date(year,Number(match[2])-1,Number(match[1]),12); }
    const links=[...match[4].matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(link=>({url:link[1],title:stripHtml(link[2])})).filter(link=>link.title && !/^\[\]$/.test(link.title));
    const listing=links.at(-1), day=date.toISOString().slice(0,10), title=listing?.title; if(!title || date<start || date>end) continue;
    const [hour,minute]=match[3].split(':').map(Number), begins=new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`), ends=new Date(+begins+120*60*1000);
    found.push({id:`karlstorkino-${day}-${String(hour).padStart(2,'0')}${String(minute).padStart(2,'0')}-${slug(title)}`,title,city:'heidelberg',category:'film',start:toLocal(begins),end:toLocal(ends),approximateEnd:true,venue:'Karlstorkino (Südstadt)',description:'Film screening from the Karlstorkino programme. The programme publishes the start time but not a common end time; the end shown here is an approximate two hours for overlap planning.',source:new URL(listing.url,source.url).href,sourceName:source.name});
  }
  return found;
}
async function collectSapArena(source){
  const response=await fetch(source.url,{headers:{'user-agent':'Rheinplan weekly event collector/1.0 (+calendar source link)'}});
  if(!response.ok) throw new Error(`${response.status} SAP Arena`);
  const html=await response.text(), found=[];
  for(const block of html.matchAll(/<li class=["']event["'][^>]*>([\s\S]*?)<\/li>/gi)){
    const content=block[1], date=content.match(/<p>\s*(\d{2}\.\d{2}\.\d{4})\s*<\/p>/i)?.[1], clock=content.match(/<p>\s*(\d{1,2}:\d{2})\s*Uhr\s*<\/p>/i)?.[1], link=content.match(/<a href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!date || !clock || !link) continue;
    const day=germanDate(date), [hour,minute]=clock.split(':').map(Number), begins=new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`); if(begins<start||begins>end) continue;
    const title=stripHtml(link[2]), category=stripHtml(content.match(/event-category-link[^>]*>([\s\S]*?)<\/a>/i)?.[1]||'');
    found.push({id:`sap-arena-${slug(title)}-${day}-${clock.replace(':','')}`,title,city:'mannheim',category:categoryFor(`${title} ${category}`),start:toLocal(begins),end:toLocal(new Date(+begins+150*60*1000)),approximateEnd:true,venue:'SAP Arena Mannheim',description:`${category || 'Event'} at SAP Arena. The advertised start time is exact; the end is estimated only for overlap planning.`,source:new URL(link[1],source.url).href,sourceName:source.name});
  }
  return found;
}
function germanWordDate(day, month, year) {
  const months={januar:0,februar:1,maerz:2,märz:2,april:3,mai:4,juni:5,juli:6,august:7,september:8,oktober:9,november:10,dezember:11};
  const index=months[String(month).toLowerCase()]; if(index===undefined) return null;
  let numericYear=Number(year||start.getFullYear());
  let date=new Date(numericYear,index,Number(day),12);
  if(!year && date<new Date(start.getFullYear(),start.getMonth()-1,1)) date=new Date(++numericYear,index,Number(day),12);
  return date;
}
async function collectPlanken(source){
  const response=await fetch(source.url,{headers:{'user-agent':'Rheinplan daily event collector/1.0 (+calendar source link)'}});
  if(!response.ok) throw new Error(`${response.status} Planken Lichtspiele`);
  const html=await response.text(), found=[], seen=new Set();
  for(const anchor of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    const text=stripHtml(anchor[2]);
    if(!/special event|\blive aus\b|nur am|kino\s*&\s*kuchen|sneak/i.test(text)) continue;
    const title=text.replace(/\s*(?:special event|live aus|nur am|kino\s*&\s*kuchen|sneak)[\s\S]*$/i,'').trim();
    if(!title) continue;
    const dates=/((?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\s*,?\s*)?(\d{1,2})\.\s*(januar|februar|m(?:ä|ae)rz|april|mai|juni|juli|august|september|oktober|november|dezember)(?:\s*(\d{4}))?\s*(?:um\s*)?(\d{1,2})[.:](\d{2})/gi;
    for(const match of text.matchAll(dates)){
      const date=germanWordDate(match[2],match[3],match[4]); if(!date) continue;
      const begins=new Date(date.getFullYear(),date.getMonth(),date.getDate(),Number(match[5]),Number(match[6]));
      if(begins<start || begins>end) continue;
      const id=`planken-${dateKey(begins)}-${match[5]}${match[6]}-${slug(title)}`; if(seen.has(id)) continue; seen.add(id);
      found.push({id,title,city:'mannheim',category:'film',start:toLocal(begins),end:toLocal(new Date(+begins+120*60*1000)),approximateEnd:true,venue:'Planken Lichtspiele Mannheim',description:'Promoted special screening from the official Planken Lichtspiele programme. The end is estimated only for overlap planning.',source:new URL(anchor[1],source.url).href,sourceName:source.name});
    }
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
const structuredSources=sources.filter(source=>!['heidelberg-calendar','mannheim-calendar','karlstorkino','sap-arena','planken'].includes(source.kind));
const settled = await Promise.allSettled([...structuredSources.map(collectJsonLd), ...sources.filter(source=>source.kind==='heidelberg-calendar').map(collectHeidelbergCalendar), ...sources.filter(source=>source.kind==='mannheim-calendar').map(collectMannheimCalendar), ...sources.filter(source=>source.kind==='karlstorkino').map(collectKarlstorkino), ...sources.filter(source=>source.kind==='sap-arena').map(collectSapArena), ...sources.filter(source=>source.kind==='planken').map(collectPlanken)]);
for(const result of settled) if(result.status==='rejected') console.warn(`Source skipped: ${result.reason.message}`);
const publicEvents = settled.flatMap(result => result.status==='fulfilled' ? result.value : []);
const imported = [...publicEvents, ...(await collectTicketmaster())];
const ids = new Set(data.events.map(event=>event.id));
const eventKey = event => `${event.city}|${event.title.trim().toLowerCase()}|${event.start}`;
const eventKeys = new Set(data.events.map(eventKey));
const existingById = new Map(data.events.map(event=>[event.id,event]));
for(const event of imported) {
  if(existingById.has(event.id)) Object.assign(existingById.get(event.id),event);
  else if(!eventKeys.has(eventKey(event))) { data.events.push(event); ids.add(event.id); eventKeys.add(eventKey(event)); existingById.set(event.id,event); }
}
data.events = data.events.filter(event => new Date(event.end) >= start && new Date(event.start) <= end).sort((a,b)=>new Date(a.start)-new Date(b.start));
data.generatedAt = new Date().toISOString(); data.window = {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
await writeFile(new URL('../events.json', import.meta.url), `${JSON.stringify(data,null,2)}\n`);
console.log(`Saved ${data.events.length} current listings (${imported.length} imported candidates).`);
