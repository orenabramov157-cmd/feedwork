const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const req = fs.readFileSync('public/req.js','utf8');
function harness(search='', response=()=>Promise.resolve({ok:true,json:async()=>({ok:true})})) {
  const events={}, calls=[], nodes={}, radios=['Ad creative','Website','Creative and website','Not sure yet'].map(value=>({value,checked:value==='Not sure yet'}));
  let focus='';
  function node(id){return nodes[id] ||= {textContent:id==='reqGo'?'Send project request':'',value:'',hidden:false,attrs:{},className:'',setAttribute(k,v){this.attrs[k]=v;},focus(){focus=id;},classList:{contains(k){return nodes[id].className.split(' ').includes(k);}}};}
  ['company','name','email','phone','product','website','notes','fax'].forEach(node);
  const card={innerHTML:'',querySelector:()=>node('success')};
  const form={parentNode:card,querySelector(s){return s.includes(':checked')?radios.find(r=>r.checked):node(s.match(/name="([^"]+)"/)[1]);},querySelectorAll(){return radios;},addEventListener(k,fn){events[k]=fn;}};
  nodes.reqForm=form;
  const context={URLSearchParams,location:{search,pathname:'/start'},document:{getElementById:node},window:{fwToken:'test-token'},FormData:class{get(k){return k==='need'?radios.find(r=>r.checked).value:node(k).value;}},fetch:(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return response();}};
  vm.runInNewContext(req,context);
  return {nodes,radios,calls,card,get focus(){return focus;},submit:()=>events.submit({preventDefault(){}}),input:(name)=>events.input({target:{name}}),change:()=>events.change(),valid(){node('company').value='Test business';node('email').value='test@example.com';}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('empty form blocks network and focuses business error',()=>{const h=harness();h.submit();assert.equal(h.calls.length,0);assert.equal(h.focus,'company');assert.match(h.nodes['email-error'].textContent,/email or phone/);});
test('malformed email blocks even when phone is present',()=>{const h=harness();h.valid();h.nodes.email.value='bad@';h.nodes.phone.value='555';h.submit();assert.equal(h.calls.length,0);assert.equal(h.focus,'email');});
test('phone-only request works and success takes focus',async()=>{const h=harness();h.nodes.company.value=' Test ';h.nodes.phone.value='555-0100';h.submit();await flush();assert.equal(h.calls[0].body.company,'Test');assert.equal(h.calls[0].body.email,'');assert.equal(h.focus,'success');assert.match(h.card.innerHTML,/Request received/);});
test('valid context retained in backend-supported need field, notes untouched',async()=>{const h=harness('?service=both&style=expressive');h.valid();h.nodes.notes.value='a'.repeat(4000);h.submit();await flush();assert.equal(h.calls[0].body.need,'Creative and website / expressive');assert.ok(h.calls[0].body.need.length<=40);assert.equal(h.calls[0].body.notes.length,4000);assert.equal(h.calls[0].body.prospectToken,'test-token');assert.equal(h.calls[0].url,'/api/lead');});
test('changing to creative removes website context',()=>{const h=harness('?service=website&style=bold');h.radios.forEach(r=>r.checked=r.value==='Ad creative');h.change();assert.equal(h.nodes['style-context'].hidden,true);h.valid();h.submit();assert.equal(h.calls[0].body.need,'Ad creative');});
test('unknown query values are ignored',()=>{const h=harness('?service=other&style=%3Cscript%3E');assert.equal(h.radios.find(r=>r.checked).value,'Not sure yet');assert.equal(h.nodes['style-context'].hidden,true);});
test('duplicate submit suppressed while request pending',async()=>{let resolve;const h=harness('',()=>new Promise(r=>resolve=r));h.valid();h.submit();h.submit();assert.equal(h.calls.length,1);assert.equal(h.nodes.reqGo.disabled,true);resolve({ok:true,json:async()=>({ok:true})});await flush();});
for(const [label,response] of [
  ['HTTP failure despite ok JSON',()=>Promise.resolve({ok:false,json:async()=>({ok:true})})],
  ['application rejection',()=>Promise.resolve({ok:true,json:async()=>({ok:false})})],
  ['non-JSON response',()=>Promise.resolve({ok:true,json:async()=>{throw Error('bad json');}})],
  ['network failure',()=>Promise.reject(Error('offline'))]
]) test(label+' preserves input and permits retry',async()=>{const h=harness('',response);h.valid();h.nodes.notes.value='Keep my brief';h.submit();await flush();assert.equal(h.nodes.reqGo.disabled,false);assert.equal(h.nodes.reqGo.textContent,'Send project request');assert.equal(h.nodes.notes.value,'Keep my brief');assert.equal(h.card.innerHTML,'');assert.match(h.nodes.reqNote.textContent,/could not be sent/);h.submit();await flush();assert.equal(h.calls.length,2);});
const cal=fs.readFileSync('public/cal.js','utf8');
function calendar(url){const scripts=[];const mount={innerHTML:'contact fallback',children:[],replaceChildren(...nodes){this.children=nodes;},prepend(node){this.children.unshift(node);}};const document={getElementById:()=>mount,createElement:()=>({style:{},attrs:{},children:[],setAttribute(k,v){this.attrs[k]=v;},appendChild(node){this.children.push(node);}}),head:{appendChild:s=>scripts.push(s)}};vm.runInNewContext(cal,{document,window:{FW_CALENDLY:url},URL});return {mount,scripts};}
test('empty and invalid calendars leave working contact fallback',()=>{for(const url of ['', 'https://evil.test/a/b','https://calendly.com.evil.test/a/b','javascript:alert(1)','https://calendly.com/owner']){const h=calendar(url);assert.equal(h.scripts.length,0);assert.equal(h.mount.innerHTML,'contact fallback');}});
test('valid calendar has direct link and restores contact options on load failure',()=>{const h=calendar('https://calendly.com/owner/event');assert.equal(h.scripts.length,1);assert.equal(h.mount.children[0].children[0].href,'https://calendly.com/owner/event');assert.doesNotMatch(h.mount.children[1].attrs['data-url'],/hide_gdpr/);h.scripts[0].onerror();assert.equal(h.mount.innerHTML,'contact fallback');});
