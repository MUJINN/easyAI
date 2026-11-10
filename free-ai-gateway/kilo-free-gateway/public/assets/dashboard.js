    const $ = (selector) => document.querySelector(selector);

    // Lasso selection state (must be declared before ModelCatalog class which references it)
    const lassoRect = $('#selection-lasso rect');
    let lasso = null;
    let suppressLassoClick = false;
    let clearLassoClickSuppression;

    // ====== ModelCatalog 类：统一目录、选择、测试逻辑 ======
    class ModelCatalog {
      constructor(cfg) {
        Object.assign(this, cfg);
        this.models = [];
        this.loaded = false;
        this.selection = new Set();
        this.results = new Map();
        this.testing = false;
        this.stopRequested = false;
        this.anchor = '';
        this.selectedOnly = false;
        this._bind();
      }

      async load() {
        if (this.testing) return;
        const btn = $(this.sels.loadBtn), st = $(this.sels.status);
        btn.disabled = true; st.textContent = `正在读取 ${this.providerName} 模型目录…`;
        try {
          const r = await fetch(this.catalogEndpoint, {headers: apiHeaders()});
          const txt = await r.text();
          let p; try { p = JSON.parse(txt); } catch { p = txt; }
          if (!r.ok) {
            const failure = failureMessage(r.status, p, r.headers);
            const error = new Error(`${failure.summary}\n${failure.details}`);
            error.status = r.status;
            throw error;
          }
          this.models = p.data || [];
          this.loaded = true; this._prune();
          st.textContent = `目录更新于 ${new Date(p.checked_at).toLocaleTimeString()} · ${this.models.length} 个模型`;
          if (this.providerName === 'Kilo') $('#local-key-status').textContent = '连接成功。';
          this.render(); this.updateControls();
        } catch (e) {
          st.textContent = `${this.providerName} 目录加载失败`; this._renderErr(e);
          if (this.providerName === 'Kilo') {
            $('#local-key-status').textContent = e.status === 401
              ? '口令未通过验证，请检查后重试。'
              : '连接失败，请查看目录提示后重试。';
            if (e.status === 401) $('#connection-settings').open = true;
          }
        } finally { btn.disabled = false; }
      }

      getFilteredModels() {
        const q = this.sels.search ? $(this.sels.search).value.trim().toLowerCase() : '';
        const free = this.sels.freeOnly ? $(this.sels.freeOnly).checked : false;
        return this.models.filter(m => {
          const hay = `${m.id} ${m.name||''} ${m.owned_by||''} ${(m.tags||[]).join(' ')}`.toLowerCase();
          return hay.includes(q) && this.extraFilter(m) && (!free || m.isFree === true);
        });
      }

      getVisibleModels() {
        const filtered = this.getFilteredModels();
        return this.selectedOnly ? filtered.filter(m => this.selection.has(m.id)) : filtered;
      }

      render() {
        const root = $(this.sels.catalog), list = this.getVisibleModels();
        root.replaceChildren();
        if (!list.length) { const d=document.createElement('div'); d.className='empty'; d.textContent=this.selectedOnly?'当前筛选条件下没有已选模型。':'没有匹配的模型。'; root.append(d); return; }
        list.forEach(m => root.append(this._card(m)));
      }

      _card(m) {
        const c = document.createElement('article');
        c.className = 'card'; c.dataset.modelId = m.id; c.tabIndex = this.testing ? -1 : 0;
        c.setAttribute('role','group'); c.dataset.testSelected = String(this.selection.has(m.id));
        c.setAttribute('aria-label', `${m.id}${this.selection.has(m.id)?'，已选中测试':''}`);
        c.addEventListener('click', e => {
          if (suppressLassoClick){ suppressLassoClick=false; clearTimeout(clearLassoClickSuppression); return; }
          if (e.target.closest('button, details, summary, a')) return;
          this.select(m.id, {range:e.shiftKey});
        });
        c.addEventListener('keydown', e => {
          if (e.target.closest('button, details, summary, a')) return;
          if (e.key==='Enter'||e.key===' '){ e.preventDefault(); this.select(m.id,{range:e.shiftKey}); }
        });

        const h = document.createElement('div'); h.className='card-heading';
        const chk = document.createElement('span'); chk.className='card-check'; chk.setAttribute('aria-hidden','true'); h.append(chk);
        const tg = document.createElement('div'); tg.className='card-title-group';
        const title = document.createElement('h2'); title.textContent = m.id; tg.append(title);
        const copyBtn = document.createElement('button'); copyBtn.className='copy-model-button'; copyBtn.type='button'; copyBtn.textContent='复制';
        copyBtn.setAttribute('aria-label',`复制模型名 ${m.id}`);
        copyBtn.addEventListener('click', async ev => { ev.stopPropagation(); try{ await copyText(m.id); copyBtn.textContent='已复制'; setTimeout(()=>copyBtn.textContent='复制',1200);}catch{ copyBtn.textContent='复制失败'; setTimeout(()=>copyBtn.textContent='复制',2000);} });
        tg.append(copyBtn); h.append(tg); c.append(h);
        if (m.name && m.name!==m.id) { const n=document.createElement('p'); n.className='model-name'; n.textContent=m.name; c.append(n); }
        if (this.selection.has(m.id)) { const s=document.createElement('div'); s.className='selection-status'; s.textContent='已选用于测试'; c.append(s); }

        const badges = document.createElement('div'); badges.className='badges';
        const prov = document.createElement('span'); prov.className='badge'; prov.textContent=this.providerName;
        prov.style.borderColor='var(--selected-border)'; prov.style.background='var(--selected-bg)'; prov.style.color='var(--selected-text)'; badges.append(prov);
        for (const t of m.tags||[]) { const b=document.createElement('span'); b.className='badge'; b.textContent=capabilityLabel(t); if(b.textContent!==t) b.title=t; badges.append(b); }
        this.renderExtraBadges(m).forEach(b=>badges.append(b));
        c.append(badges);

        const owner = document.createElement('p'); owner.className='meta provider-meta';
        const ups = Array.isArray(m.inference_provider_ids)?m.inference_provider_ids.filter(Boolean):[];
        owner.textContent = `上游：${ups.length?ups.join('、'):m.upstream||m.owned_by||'未说明'}`; owner.title=owner.textContent; c.append(owner);

        const ctx = formatTokens(m.context_length||m.top_provider?.context_length) || (m.ctx?`${formatTokens(m.ctx)}（项目估算）`:'');
        if (ctx) { const p=document.createElement('p'); p.className='meta'; p.textContent=`上下文上限：${ctx}`; c.append(p); }
        const maxOut = formatTokens(m.top_provider?.max_completion_tokens); if (maxOut) { const p=document.createElement('p'); p.className='meta'; p.textContent=`单次回复上限：${maxOut}`; c.append(p); }
        const inMod = m.architecture?.input_modalities, outMod = m.architecture?.output_modalities;
        if (Array.isArray(inMod)||Array.isArray(outMod)) { const p=document.createElement('p'); p.className='meta'; p.textContent=`输入/输出：${(Array.isArray(inMod)?inMod.map(modalityLabel).join('、'):'未说明')} → ${(Array.isArray(outMod)?outMod.map(modalityLabel).join('、'):'未说明')}`; c.append(p); }
        const params = Array.isArray(m.supported_parameters)?m.supported_parameters:[];
        const caps = []; if(params.includes('tools')||params.includes('tool_choice')) caps.push('工具调用'); if(params.includes('reasoning')||params.includes('include_reasoning')) caps.push('推理参数'); if(params.includes('structured_outputs')||params.includes('response_format')) caps.push('结构化输出');
        if (caps.length) { const p=document.createElement('p'); p.className='meta'; p.textContent=`接口能力：${caps.join('、')}`; c.append(p); }
        this.renderExtraMeta(c, m);

        if (m.description) { const d=document.createElement('div'); d.className='description'; const det=document.createElement('details'); const sum=document.createElement('summary'); sum.textContent='查看完整说明'; const fp=document.createElement('p'); fp.textContent=String(m.description).trim(); det.append(sum,fp); d.append(det); c.append(d); }
        if (m.expiration_date) { const exp=new Date(m.expiration_date); const p=document.createElement('p'); p.className='meta'; p.textContent=`目录标注到期时间：${isNaN(exp.getTime())?m.expiration_date:exp.toLocaleDateString()}`; c.append(p); }
        if (m.mayTrainOnYourPrompts===true) { const w=document.createElement('span'); w.className='badge warning'; w.textContent='上游可能使用提示词改进服务'; w.title='该信息由上游模型目录提供；发送敏感信息前请查看提供方政策。'; badges.append(w); }

        const tb = document.createElement('button'); tb.className='test-model-button'; tb.textContent=this.results.get(m.id)?.status==='running'?'测试中…':'连通测试'; tb.disabled=this.testing; tb.addEventListener('click',()=>this.runTests([m.id]));
        const cb = document.createElement('button'); cb.className='configure-model-button'; cb.textContent='接入客户端'; cb.setAttribute('aria-label',`将 ${m.id} 接入客户端`); cb.addEventListener('click',()=>openSetupDialog(m, m.provider || m.upstream));
        c.append(tb,cb); appendCardResult(c, this.results.get(m.id)); return c;
      }

      select(id,{range=false}={}) { if(this.testing) return; const list=this.getVisibleModels(), i=list.findIndex(m=>m.id===id); if(i<0) return; if(range){ const a=list.findIndex(m=>m.id===this.anchor); const s=a<0?i:Math.min(a,i), e=a<0?i:Math.max(a,i); list.slice(s,e+1).forEach(m=>this.selection.add(m.id)); } else if(this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); this.anchor=id; this.render(); this.updateControls(); }
      clearSelection() { if(this.testing) return; this.selection.clear(); this.anchor=''; this.render(); this.updateControls(); }
      selectAll() { if(this.testing) return; this.getVisibleModels().forEach(m=>this.selection.add(m.id)); this.anchor=this.getVisibleModels().length?this.getVisibleModels()[this.getVisibleModels().length-1].id:''; this.render(); this.updateControls(); }

      async runTests(ids=[...this.selection]) {
        if (this.testing || !ids.length) return;
        const prompt = $(this.sels.testPrompt).value;
        if (ids.length > 5) {
          const promptPreview = prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
          const promptSummary = promptPreview ? `\n提示词预览：${promptPreview}${promptPreview.length < prompt.trim().length ? '…' : ''}` : '\n当前提示词为空。';
          if (!window.confirm(`即将向 ${this.providerName} 上游依次发送 ${ids.length} 个请求，可能消耗额度或发送到不同服务商。${promptSummary}\n确定开始批量测试吗？`)) return;
        }
        this.testing=true; this.stopRequested=false; ids.forEach(id=>this.results.set(id,{status:'queued'})); this.updateControls(); this.render(); this._showResult(`准备按顺序测试 ${ids.length} 个 ${this.providerName} 模型…`,true); let ok=0, done=0; try{ for(const [i,id] of ids.entries()){ if(this.stopRequested) break; this.results.set(id,{status:'running'}); this._showResult(`正在测试 ${id}（${i+1}/${ids.length}）…`,true); this.render(); const t0=performance.now(); try{ const r=await fetch(this.testEndpoint,{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({model:id,prompt})}); const raw=await r.text(); const el=(performance.now()-t0)/1000; let p; try{p=JSON.parse(raw);}catch{p=raw;} if(!r.ok){ this.results.set(id,{status:'failed',elapsed:el,error:failureMessage(r.status,p,r.headers)}); }else{ this.results.set(id,{status:'success',elapsed:el,answer:p.choices?.[0]?.message?.content||JSON.stringify(p,null,2)}); ok++; } }catch(e){ this.results.set(id,{status:'failed',elapsed:(performance.now()-t0)/1000,error:`本机连接失败：${e.message}\n建议：确认网关仍在运行，浏览器打开的是 http://127.0.0.1:8899/；若刚设置 LOCAL_KEY，请重新填写并保存。`}); } done++; this.render(); } }finally{ if(this.stopRequested) ids.forEach(id=>{ if(this.results.get(id)?.status==='queued') this.results.set(id,{status:'stopped'}); }); this.testing=false; this.stopRequested=false; this.updateControls(); this.render(); const all=ok===ids.length; const msg=this.stopRequested?`已停止：完成 ${done}/${ids.length} 个模型，其中 ${ok} 个成功。`:`测试完成：${ok}/${ids.length} 个模型成功。`; this._showResult(`${msg} 各模型的回复或错误显示在对应卡片中。`,!this.stopRequested&&all); } }
      stop() { if(!this.testing||this.stopRequested) return; this.stopRequested=true; this.updateControls(); this._showResult('已请求停止。当前模型的请求结束后，将不会继续请求后续模型。',true); }

      updatePromptPreview() { const note=$('#dock-prompt-preview'); if(!note) return; const prompt=$(this.sels.testPrompt).value.trim().replace(/\s+/g,' '); note.textContent=prompt?`测试提示词：${prompt.slice(0,100)}${prompt.length>100?'…':''}`:'测试提示词为空；开始前可编辑。'; }

      updateControls() { const n=this.selection.size, filteredSelected=this.getFilteredModels().filter(m=>this.selection.has(m.id)).length, hiddenSelected=n-filteredSelected, t=this.testing, sr=this.stopRequested; $(this.sels.selectionStatus).textContent=n?`已选 ${n} 个；当前筛选可见 ${filteredSelected} 个${hiddenSelected?`，另有 ${hiddenSelected} 个被筛选隐藏`:''}。Shift 点击可范围多选，Ctrl+A 全选当前结果。`:'点击卡片选中；按住鼠标左键拖框，Shift 点击可范围多选。Ctrl+A 全选当前结果。'; const dock=$('#selection-dock'); dock.classList.toggle('visible',n>0); document.body.classList.toggle('has-selection-dock',n>0); $('#dock-selection-count').textContent=`已选择 ${n} 个模型`; this.updatePromptPreview(); const dis=(sel,lab)=>{const b=$(sel); if(b){b.disabled=t||n===0;b.textContent=t?'测试中…':lab;}}; const disStop=(sel)=>{const b=$(sel); if(b){b.hidden=!t;b.disabled=!t||sr;b.textContent=sr?'正在停止…':'停止测试';}}; const selectVisible=$(this.sels.selectVisibleBtn); if(selectVisible){selectVisible.disabled=t||this.getVisibleModels().length===0;} const selectedOnly=$(this.sels.selectedOnlyBtn); if(selectedOnly){selectedOnly.disabled=t||n===0; selectedOnly.setAttribute('aria-pressed',String(this.selectedOnly)); selectedOnly.textContent=this.selectedOnly?'显示全部结果':'仅看已选';} dis(this.sels.topTestBtn,'测试'); dis(this.sels.clearSelBtn,'清空选择'); disStop(this.sels.topStopBtn); const sbtn=$(this.sels.testBtn); if(sbtn){sbtn.disabled=t||n===0; sbtn.textContent=t?'按顺序测试中…':n>0?`逐个测试已选模型（${n}）`:'请选择模型';} $('#dock-test-button').disabled=t||n===0; $('#dock-stop-button').hidden=!t; $('#dock-stop-button').disabled=!t||sr; $('#dock-clear-button').disabled=t||n===0; }

      _bind(){ if(this.sels.search) $(this.sels.search).addEventListener('input',()=>{this.render();this.updateControls();}); if(this.sels.freeOnly) $(this.sels.freeOnly).addEventListener('change',()=>{this.render();this.updateControls();}); $(this.sels.testPrompt).addEventListener('input',()=>this.updatePromptPreview()); $(this.sels.loadBtn).addEventListener('click',()=>this.load()); $(this.sels.clearSelBtn).addEventListener('click',()=>this.clearSelection()); $(this.sels.selectVisibleBtn).addEventListener('click',()=>this.selectAll()); $(this.sels.selectedOnlyBtn).addEventListener('click',()=>{this.selectedOnly=!this.selectedOnly;this.render();this.updateControls();}); $(this.sels.topTestBtn).addEventListener('click',()=>this.runTests()); $(this.sels.topStopBtn).addEventListener('click',()=>this.stop()); $(this.sels.testBtn)?.addEventListener('click',()=>this.runTests()); }
      _prune(){ const ids=new Set(this.models.map(m=>m.id)); this.selection=new Set([...this.selection].filter(id=>ids.has(id))); if(!ids.has(this.anchor)) this.anchor=''; }
      _showResult(msg,good){ const b=$(this.sels.testResult); b.className=`result ${good?'good':'bad'}`; b.textContent=msg; b.hidden=false; }
      _renderErr(e){ const root=$(this.sels.catalog); root.replaceChildren(); const d=document.createElement('div'); d.className='empty'; const fm=failureMessage(0,e.message,new Headers()); d.textContent=`${fm.summary}\n${fm.details}`; root.append(d); }
    }

    // ====== 实例化三个目录 ======
    const kiloCatalog = new ModelCatalog({
      sels: {
        catalog: '#catalog', search: '#search', freeOnly: '#free-only',
        status: '#catalog-status', loadBtn: '#refresh',
        testPrompt: '#test-prompt', testBtn: '#test-button', testResult: '#test-result',
        topTestBtn: '#top-test-button', topStopBtn: '#top-stop-button', clearSelBtn: '#clear-selection',
        selectVisibleBtn: '#select-visible-button', selectedOnlyBtn: '#selected-only-button',
        selectionStatus: '#selection-status',
      },
      catalogEndpoint: '/api/catalog', testEndpoint: '/api/test', providerName: 'Kilo',
      extraFilter: () => true,
      renderExtraBadges: m => { const b=document.createElement('span'); b.className=`badge ${m.isFree===true?'free':m.isFree===false?'':'unknown'}`; b.textContent=m.isFree===true?'上游标记免费':m.isFree===false?'非免费':'免费状态未知'; return [b]; },
      renderExtraMeta: (card,m) => { /* Kilo 无额外元数据 */ }
    });

    const sensenovaCatalog = new ModelCatalog({
      sels: {
        catalog: '#sensenova-catalog', search: '#sensenova-search', freeOnly: null,
        status: '#sensenova-catalog-status', loadBtn: '#load-sensenova-catalog',
        testPrompt: '#sensenova-test-prompt', testBtn: '#sensenova-test-button', testResult: '#sensenova-test-result',
        topTestBtn: '#sensenova-top-test-button', topStopBtn: '#sensenova-top-stop-button', clearSelBtn: '#sensenova-clear-selection',
        selectVisibleBtn: '#sensenova-select-visible-button', selectedOnlyBtn: '#sensenova-selected-only-button',
        selectionStatus: '#sensenova-selection-status',
      },
      catalogEndpoint: '/api/sensenova/catalog', testEndpoint: '/api/sensenova/test', providerName: 'SenseNova',
      extraFilter: () => true,
      renderExtraBadges: () => [],
      renderExtraMeta: (card,m) => { /* SenseNova 无额外元数据 */ }
    });

    const internlmCatalog = new ModelCatalog({
      sels: {
        catalog: '#internlm-catalog', search: '#internlm-search', freeOnly: null,
        status: '#internlm-catalog-status', loadBtn: '#load-internlm-catalog',
        testPrompt: '#internlm-test-prompt', testBtn: '#internlm-test-button', testResult: '#internlm-test-result',
        topTestBtn: '#internlm-top-test-button', topStopBtn: '#internlm-top-stop-button', clearSelBtn: '#internlm-clear-selection',
        selectVisibleBtn: '#internlm-select-visible-button', selectedOnlyBtn: '#internlm-selected-only-button',
        selectionStatus: '#internlm-selection-status',
      },
      catalogEndpoint: '/api/internlm/catalog', testEndpoint: '/api/internlm/test', providerName: 'InternLM',
      extraFilter: () => true,
      renderExtraBadges: () => [],
      renderExtraMeta: (card,m) => { /* InternLM 无额外元数据 */ }
    });

    const scnetCatalog = new ModelCatalog({
      sels: {
        catalog: '#scnet-catalog', search: '#scnet-search', freeOnly: null,
        status: '#scnet-catalog-status', loadBtn: '#load-scnet-catalog',
        testPrompt: '#scnet-test-prompt', testBtn: '#scnet-test-button', testResult: '#scnet-test-result',
        topTestBtn: '#scnet-top-test-button', topStopBtn: '#scnet-top-stop-button', clearSelBtn: '#scnet-clear-selection',
        selectVisibleBtn: '#scnet-select-visible-button', selectedOnlyBtn: '#scnet-selected-only-button',
        selectionStatus: '#scnet-selection-status',
      },
      catalogEndpoint: '/api/scnet/catalog', testEndpoint: '/api/scnet/test', providerName: 'SCNet',
      extraFilter: () => true,
      renderExtraBadges: () => [],
      renderExtraMeta: (card,m) => { /* SCNet 无额外元数据 */ }
    });

    // Get active catalog from the currently displayed page.
    function getActiveCatalog() {
      if (!$('#kilo-view').hidden) return kiloCatalog;
      if (!$('#sensenova-view').hidden) return sensenovaCatalog;
      if (!$('#internlm-view').hidden) return internlmCatalog;
      if (!$('#scnet-view').hidden) return scnetCatalog;
      return null;
    }

    // ====== 兼容旧代码的全局 state 引用 ======
    const state = {
      // Kilo
      get models(){ return kiloCatalog.models; }, set models(v){ kiloCatalog.models=v; },
      get catalogLoaded(){ return kiloCatalog.loaded; }, set catalogLoaded(v){ kiloCatalog.loaded=v; },
      get testSelection(){ return getActiveCatalog()?.selection || new Set(); }, set testSelection(v){ const c=getActiveCatalog(); if(c) c.selection=v; },
      get testResults(){ return getActiveCatalog()?.results || new Map(); }, set testResults(v){ const c=getActiveCatalog(); if(c) c.results=v; },
      get testing(){ return getActiveCatalog()?.testing || false; }, set testing(v){ const c=getActiveCatalog(); if(c) c.testing=v; },
      get stopRequested(){ return getActiveCatalog()?.stopRequested || false; }, set stopRequested(v){ const c=getActiveCatalog(); if(c) c.stopRequested=v; },
      get selectionAnchor(){ return getActiveCatalog()?.anchor || ''; }, set selectionAnchor(v){ const c=getActiveCatalog(); if(c) c.anchor=v; },
      // SenseNova
      get sensenovaModels(){ return sensenovaCatalog.models; }, set sensenovaModels(v){ sensenovaCatalog.models=v; },
      get sensenovaCatalogLoaded(){ return sensenovaCatalog.loaded; }, set sensenovaCatalogLoaded(v){ sensenovaCatalog.loaded=v; },
      get sensenovaTestSelection(){ return sensenovaCatalog.selection; }, set sensenovaTestSelection(v){ sensenovaCatalog.selection=v; },
      get sensenovaTestResults(){ return sensenovaCatalog.results; }, set sensenovaTestResults(v){ sensenovaCatalog.results=v; },
      get sensenovaTesting(){ return sensenovaCatalog.testing; }, set sensenovaTesting(v){ sensenovaCatalog.testing=v; },
      get sensenovaStopRequested(){ return sensenovaCatalog.stopRequested; }, set sensenovaStopRequested(v){ sensenovaCatalog.stopRequested=v; },
      get sensenovaSelectionAnchor(){ return sensenovaCatalog.anchor; }, set sensenovaSelectionAnchor(v){ sensenovaCatalog.anchor=v; },
      // InternLM
      get internlmModels(){ return internlmCatalog.models; }, set internlmModels(v){ internlmCatalog.models=v; },
      get internlmCatalogLoaded(){ return internlmCatalog.loaded; }, set internlmCatalogLoaded(v){ internlmCatalog.loaded=v; },
      get internlmTestSelection(){ return internlmCatalog.selection; }, set internlmTestSelection(v){ internlmCatalog.selection=v; },
      get internlmTestResults(){ return internlmCatalog.results; }, set internlmTestResults(v){ internlmCatalog.results=v; },
      get internlmTesting(){ return internlmCatalog.testing; }, set internlmTesting(v){ internlmCatalog.testing=v; },
      get internlmStopRequested(){ return internlmCatalog.stopRequested; }, set internlmStopRequested(v){ internlmCatalog.stopRequested=v; },
      get internlmSelectionAnchor(){ return internlmCatalog.anchor; }, set internlmSelectionAnchor(v){ internlmCatalog.anchor=v; },
      // 共享
      vault: null, theme: document.documentElement.dataset.theme==='light'?'light':'dark',
      key: sessionStorage.getItem('gateway-local-key')||'',
    };
    $('#local-key').value = state.key;

    function updateThemeToggle() {
      const nextTheme = state.theme === 'light' ? '暗色' : '亮色';
      const label = `切换到${nextTheme}主题`;
      const button = $('#theme-toggle');
      button.setAttribute('aria-label', label);
      button.title = label;
      $('#theme-icon').textContent = state.theme === 'light' ? '☾' : '☀';
    }

    $('#theme-toggle').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      if (state.theme === 'dark') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.dataset.theme = state.theme;
      updateThemeToggle();
      try {
        localStorage.setItem('gateway-theme', state.theme);
      } catch (error) {
        console.warn('Could not save theme preference:', error);
      }
    });

    function apiHeaders(extra = {}) {
      return { ...extra, ...(state.key ? { Authorization: `Bearer ${state.key}` } : {}) };
    }

    async function vaultRequest(path, { method = 'GET', body } = {}) {
      const headers = apiHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload.error?.message || `请求失败（HTTP ${response.status}）`);
          error.status = response.status;
          throw error;
        }
        return payload;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function renderVaultStatus() {
      const vault = state.vault;
      const initialized = Boolean(vault?.initialized);
      const unlocked = Boolean(vault?.unlocked);
      $('#vault-locked').hidden = unlocked;
      $('#vault-unlocked').hidden = !unlocked;
      $('#vault-password-label').textContent = initialized ? '凭据库主密码' : '设置主密码（至少 12 个字符）';
      $('#vault-password').placeholder = initialized ? '输入主密码以解锁' : '首次设置至少 12 个字符';
      $('#vault-password').minLength = initialized ? 1 : 12;
      $('#vault-unlock-button').textContent = initialized ? '解锁凭据库' : '创建并解锁凭据库';

      const sensenova = vault?.providers?.find((provider) => provider.id === 'sensenova');
      $('#sensenova-provider-state').textContent = sensenova?.configured
        ? 'Key 已加密保存'
        : '尚未配置 Key';
      $('#delete-sensenova-key').disabled = !sensenova?.configured;

      const internlm = vault?.providers?.find((provider) => provider.id === 'internlm');
      $('#internlm-provider-state').textContent = internlm?.configured
        ? 'Key 已加密保存'
        : '尚未配置 Key';
      $('#delete-internlm-key').disabled = !internlm?.configured;

      const scnet = vault?.providers?.find((provider) => provider.id === 'scnet');
      $('#scnet-provider-state').textContent = scnet?.configured
        ? 'Key 已加密保存'
        : '尚未配置 Key';
      $('#delete-scnet-key').disabled = !scnet?.configured;

      if (!unlocked) {
        $('#vault-lock-state').textContent = initialized
          ? '凭据库已锁定；解锁后才能使用或管理 Key。'
          : '尚未创建凭据库。';
      } else {
        $('#vault-lock-state').textContent = '';
      }

    }

    // Vault status cache: avoid refetching on every tab switch
    let vaultStatusDirty = true; // true = need to fetch, false = cached

    async function loadVaultStatus() {
      if (!vaultStatusDirty && state.vault) return; // Use cached status

      $('#vault-lock-state').textContent = '正在检查本机凭据库…';
      try {
        state.vault = await vaultRequest('/api/vault/status');
        renderVaultStatus();
        vaultStatusDirty = false; // Mark as fresh
      } catch (error) {
        state.vault = null;
        $('#sensenova-provider-state').textContent = '凭据状态不可用';
        $('#internlm-provider-state').textContent = '凭据状态不可用';
        $('#scnet-provider-state').textContent = '凭据状态不可用';
        $('#vault-lock-state').textContent = error.status === 401
          ? '本地网关要求访问口令。请返回首页进入 Kilo 模型，在“连接设置”中填写并保存口令，再返回此处。'
          : error.name === 'AbortError'
            ? '请求超时，请检查网关是否正常运行。'
            : `读取凭据库状态失败：${error.message}`;
      }
    }

    function markVaultStatusDirty() {
      vaultStatusDirty = true;
    }

    function showView(name) {
      const previousCatalog = getActiveCatalog();
      if (previousCatalog && previousCatalog.testing) previousCatalog.stop();
      const views = {
        home: $('#home-view'),
        kilo: $('#kilo-view'),
        vault: $('#vault-view'),
        sensenova: $('#sensenova-view'),
        internlm: $('#internlm-view'),
        scnet: $('#scnet-view'),
      };
      for (const [viewName, element] of Object.entries(views)) {
        element.hidden = viewName !== name;
      }
      $('#home-button').hidden = name === 'home';
      $('#catalog-status').hidden = name !== 'kilo';
      window.scrollTo({ top: 0, behavior: 'auto' });
      if (name === 'kilo' && !kiloCatalog.loaded) kiloCatalog.load();
      if (['vault', 'sensenova', 'internlm', 'scnet'].includes(name)) loadVaultStatus();
      const activeCatalog = getActiveCatalog();
      if (activeCatalog) {
        activeCatalog.render();
        activeCatalog.updateControls();
      } else {
        $('#selection-dock').classList.remove('visible');
        document.body.classList.remove('has-selection-dock');
      }
    }

    const providerFlowStages = [
      {
        title: '先从 SenseNova 获取 API Key',
        body: '<p>登录你自己的 SenseNova 账号，在服务商控制台申请 API Key，并确认账号权限、计费或免费额度说明。</p><p>获取 Key 后先保存在安全位置。不要把它发给他人，也不要粘贴到聊天或截图里。</p><p><a href="https://www.sensenova.cn/token-plan" target="_blank" rel="noreferrer">前往 SenseNova 官网申请 API Key</a></p>',
      },
      {
        title: '凭据由本机管理',
        body: '<p>在“本机加密凭据库”中首次设置主密码并解锁，然后输入 SenseNova Key 并加密保存。主密码不保存在磁盘；忘记主密码无法恢复 Key。</p><p>客户端使用本地网关地址；上游服务商 Key 与可选的本地网关访问口令是两种不同凭据。</p>',
      },
      {
        title: '验证连接并选择模型',
        body: '<p>接入完成后，网关会用授权凭据读取模型目录。你可以先查看模型，再手动测试选中的模型。</p><p>首版将由你明确选择 SenseNova 模型，不会在失败时悄悄切换到 Kilo 或其他服务商。</p><p>建议验证顺序：读取模型目录 → 测试一次对话 → 复制本地网关地址和模型 ID 到客户端。</p>',
      },
    ];

    const internlmFlowStages = [
      {
        title: '先从 InternLM 获取 API Key',
        body: '<p>登录你自己的 InternLM 账号，在服务商控制台申请 API Key，并确认账号权限、计费或免费额度说明。</p><p>获取 Key 后先保存在安全位置。不要把它发给他人，也不要粘贴到聊天或截图里。</p><p><a href="	https://discovery.intern-ai.org.cn/token-plan/" target="_blank" rel="noreferrer">前往 InternLM 官网申请 API Key</a></p>',
      },
      {
        title: '凭据由本机管理',
        body: '<p>在“本机加密凭据库”中首次设置主密码并解锁，然后输入 InternLM Key 并加密保存。主密码不保存在磁盘；忘记主密码无法恢复 Key。</p><p>客户端使用本地网关地址；上游服务商 Key 与可选的本地网关访问口令是两种不同凭据。</p>',
      },
      {
        title: '验证连接并选择模型',
        body: '<p>接入完成后，网关会用授权凭据读取模型目录。你可以先查看模型，再手动测试选中的模型。</p><p>首版将由你明确选择 InternLM 模型，不会在失败时悄悄切换到 Kilo 或其他服务商。</p><p>建议验证顺序：读取模型目录 → 测试一次对话 → 复制本地网关地址和模型 ID 到客户端。</p>',
      },
    ];

    function renderProviderFlowStep() {
      const step = state.sensenovaProviderFlowStep;
      const stage = providerFlowStages[step - 1];
      for (const item of document.querySelectorAll('[data-flow-step]')) {
        const isCurrent = Number(item.dataset.flowStep) === step;
        if (isCurrent) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      }
      $('#sensenova-flow-content').innerHTML = `<h4>${stage.title}</h4>${stage.body}`;
      $('#sensenova-flow-back').hidden = step === 1;
      $('#sensenova-flow-next').textContent = step === providerFlowStages.length ? '完成流程说明' : '下一步';
      $('#sensenova-provider-status').textContent = '';
    }

    $('#open-kilo').addEventListener('click', () => showView('kilo'));
    $('#open-providers').addEventListener('click', () => showView('vault'));
    $('#home-button').addEventListener('click', () => showView('home'));
    $('#vault-unlock-button').addEventListener('click', async () => {
      const password = $('#vault-password').value;
      const initialized = Boolean(state.vault?.initialized);
      const status = $('#vault-lock-state');
      const button = $('#vault-unlock-button');
      if (!password || (!initialized && password.length < 12)) {
        status.textContent = initialized ? '请输入主密码。' : '主密码至少需要 12 个字符。';
        return;
      }
      button.disabled = true;
      status.textContent = initialized ? '正在解锁凭据库…' : '正在创建加密凭据库…';
      try {
        state.vault = await vaultRequest(initialized ? '/api/vault/unlock' : '/api/vault/setup', {
          method: 'POST',
          body: { password },
        });
        renderVaultStatus();
        markVaultStatusDirty();
        $('#vault-key-status').textContent = '凭据库已解锁。';
      } catch (error) {
        status.textContent = error.message || '操作失败，请重试。';
      } finally {
        $('#vault-password').value = '';
        button.disabled = false;
      }
    });
    $('#save-sensenova-key').addEventListener('click', async () => {
      const input = $('#sensenova-api-key');
      const key = input.value.trim();
      const status = $('#vault-key-status');
      const button = $('#save-sensenova-key');
      if (!key) {
        status.textContent = '请输入 SenseNova API Key。';
        return;
      }
      button.disabled = true;
      status.textContent = '正在加密并保存…';
      try {
        state.vault = await vaultRequest('/api/vault/providers/sensenova', {
          method: 'PUT',
          body: { key },
        });
        renderVaultStatus();
        markVaultStatusDirty();
        status.textContent = 'Key 已加密保存在本机；页面不会回显或持久化它。';
      } catch (error) {
        status.textContent = error.message || '保存失败，请重试。';
      } finally {
        input.value = '';
        button.disabled = false;
      }
    });
    $('#delete-sensenova-key').addEventListener('click', async () => {
      if (!window.confirm('确定删除本机保存的 SenseNova Key 吗？')) return;
      const status = $('#vault-key-status');
      const button = $('#delete-sensenova-key');
      button.disabled = true;
      status.textContent = '正在删除…';
      try {
        state.vault = await vaultRequest('/api/vault/providers/sensenova', { method: 'DELETE' });
        renderVaultStatus();
        markVaultStatusDirty();
        status.textContent = '已删除本机保存的 SenseNova Key。';
      } catch (error) {
        status.textContent = error.message || '删除失败，请重试。';
      }
    });
    $('#vault-lock-button').addEventListener('click', async () => {
      const button = $('#vault-lock-button');
      button.disabled = true;
      $('#vault-key-status').textContent = '正在锁定凭据库…';
      $('#sensenova-api-key').value = '';
      $('#internlm-api-key').value = '';
      $('#scnet-api-key').value = '';
      try {
        state.vault = await vaultRequest('/api/vault/lock', { method: 'POST' });
        renderVaultStatus();
        markVaultStatusDirty();
        $('#vault-lock-state').textContent = '凭据库已锁定。';
      } catch (error) {
        $('#vault-key-status').textContent = error.message || '锁定失败，请重试。';
      } finally {
        button.disabled = false;
      }
    });

    // InternLM Key 保存/删除
    $('#save-internlm-key').addEventListener('click', async () => {
      const input = $('#internlm-api-key');
      const key = input.value.trim();
      const status = $('#vault-key-status');
      const button = $('#save-internlm-key');
      if (!key) {
        status.textContent = '请输入 InternLM API Key。';
        return;
      }
      button.disabled = true;
      status.textContent = '正在加密并保存…';
      try {
        state.vault = await vaultRequest('/api/vault/providers/internlm', {
          method: 'PUT',
          body: { key },
        });
        renderVaultStatus();
        markVaultStatusDirty();
        status.textContent = 'Key 已加密保存在本机；页面不会回显或持久化它。';
      } catch (error) {
        status.textContent = error.message || '保存失败，请重试。';
      } finally {
        input.value = '';
        button.disabled = false;
      }
    });
    $('#delete-internlm-key').addEventListener('click', async () => {
      if (!window.confirm('确定删除本机保存的 InternLM Key 吗？')) return;
      const status = $('#vault-key-status');
      const button = $('#delete-internlm-key');
      button.disabled = true;
      status.textContent = '正在删除…';
      try {
        state.vault = await vaultRequest('/api/vault/providers/internlm', { method: 'DELETE' });
        renderVaultStatus();
        markVaultStatusDirty();
        status.textContent = '已删除本机保存的 InternLM Key。';
      } catch (error) {
        status.textContent = error.message || '删除失败，请重试。';
      }
    });

    $('#save-scnet-key').addEventListener('click', async () => {
      const input = $('#scnet-api-key');
      const key = input.value.trim();
      const status = $('#vault-key-status');
      const button = $('#save-scnet-key');
      if (!key) {
        status.textContent = '请输入 SCNet 模型 API Key。';
        return;
      }
      button.disabled = true;
      status.textContent = '正在加密并保存…';
      try {
        state.vault = await vaultRequest('/api/vault/providers/scnet', {
          method: 'PUT',
          body: { key },
        });
        renderVaultStatus();
        markVaultStatusDirty();
        status.textContent = 'SCNet Key 已加密保存在本机；页面不会回显或持久化它。';
      } catch (error) {
        status.textContent = error.message || '保存失败，请重试。';
      } finally {
        input.value = '';
        button.disabled = false;
      }
    });
    $('#delete-scnet-key').addEventListener('click', async () => {
      if (!window.confirm('确定删除本机保存的 SCNet Key 吗？')) return;
      const status = $('#vault-key-status');
      const button = $('#delete-scnet-key');
      button.disabled = true;
      status.textContent = '正在删除…';
      try {
        state.vault = await vaultRequest('/api/vault/providers/scnet', { method: 'DELETE' });
        renderVaultStatus();
        markVaultStatusDirty();
        status.textContent = '已删除本机保存的 SCNet Key。';
      } catch (error) {
        status.textContent = error.message || '删除失败，请重试。';
      }
    });

    function errorMessage(payload) {
      if (typeof payload === 'string') {
        try { return errorMessage(JSON.parse(payload)); } catch { return payload.slice(0, 1200); }
      }
      if (!payload || typeof payload !== 'object') return '';
      const error = payload.error;
      return [
        typeof error === 'string' ? error : error?.message,
        payload.message,
        typeof error?.details === 'string' ? error.details : '',
        typeof payload.details === 'string' ? payload.details : '',
      ].find((value) => typeof value === 'string' && value.trim())?.trim().slice(0, 1200) || '';
    }

    function formatRetryAfter(value) {
      if (!value) return '';
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return `${Math.max(0, Math.ceil(seconds))} 秒后再试`;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : `约 ${date.toLocaleTimeString()} 后再试`;
    }

    function failureMessage(status, payload, headers) {
      const message = errorMessage(payload);
      let diagnosis;
      if (status === 401 && /local gateway/i.test(message)) {
        diagnosis = ['本地访问口令不正确或未填写', '打开模型目录中的“连接设置”，检查本地访问口令后重新连接。'];
      } else if (status === 400) {
        diagnosis = ['模型暂时无法接受这次请求', '刷新模型列表，或换一个模型再试。'];
      } else if (status === 401) {
        diagnosis = ['上游服务没有通过认证', '检查该服务当前是否要求账号或授权。'];
      } else if (status === 403) {
        diagnosis = ['服务商拒绝了这次请求', '可能与账号、地区或模型权限有关，请查看服务商说明。'];
      } else if (status === 404) {
        diagnosis = ['找不到这个模型或服务地址', '刷新模型列表后重新选择模型。'];
      } else if (status === 408 || status === 504) {
        diagnosis = ['模型响应超时', '稍后重试，或换一个模型。'];
      } else if (status === 429) {
        const retryAfter = formatRetryAfter(headers?.get('retry-after'));
        diagnosis = ['访问太频繁或当前额度已用完', retryAfter ? `请${retryAfter}。` : '请稍后再试，或换一个模型。'];
      } else if (status >= 500) {
        diagnosis = ['模型服务暂时出了问题', '请稍后重试，或换一个模型。'];
      } else {
        diagnosis = ['这次请求没有成功', '请稍后重试；如果仍然失败，可以查看下面的技术详情。'];
      }

      const lines = [`HTTP ${status}`, diagnosis[1]];
      if (message) lines.push(`返回信息：${message}`);
      const retryAfter = formatRetryAfter(headers?.get('retry-after'));
      if (retryAfter && status !== 429) lines.push(`Retry-After：${retryAfter}`);
      const requestId = headers?.get('x-request-id');
      if (requestId) lines.push(`上游请求 ID：${requestId}`);
      if (payload && typeof payload === 'object') {
        const raw = JSON.stringify(payload, null, 2);
        if (raw && raw !== '{}' && raw !== JSON.stringify({ error: { message } }, null, 2)) {
          lines.push(`\n详细响应：\n${raw.slice(0, 1600)}${raw.length > 1600 ? '\n（详情已截断）' : ''}`);
        }
      } else if (typeof payload === 'string' && payload.trim() && payload !== message) {
        lines.push(`\n详细响应：\n${payload.slice(0, 1600)}${payload.length > 1600 ? '\n（详情已截断）' : ''}`);
      }
      return { summary: diagnosis[0], details: lines.join('\n') };
    }

    function renderLassoRect() {
      if (!lasso?.active) return;
      lassoRect.setAttribute('x', String(Math.min(lasso.startX, lasso.endX)));
      lassoRect.setAttribute('y', String(Math.min(lasso.startY, lasso.endY)));
      lassoRect.setAttribute('width', String(Math.abs(lasso.endX - lasso.startX)));
      lassoRect.setAttribute('height', String(Math.abs(lasso.endY - lasso.startY)));
      lassoRect.hidden = false;
    }

    function finishLasso() {
      if (!lasso) return;
      const completed = lasso;
      lasso = null;
      document.body.classList.remove('is-lasso-pressed');
      document.body.classList.remove('is-lassoing');
      lassoRect.hidden = true;
      for (const attribute of ['x', 'y', 'width', 'height']) lassoRect.removeAttribute(attribute);
      if (!completed.active) return;

      const catalog = getActiveCatalog();
      if (!catalog || catalog.testing) return;

      const root = document.querySelector(catalog.sels.catalog);
      if (!root) return;

      let changed = false;
      for (const card of root.querySelectorAll('.card')) {
        const rect = card.getBoundingClientRect();
        const left = Math.min(completed.startX, completed.endX);
        const right = Math.max(completed.startX, completed.endX);
        const top = Math.min(completed.startY, completed.endY);
        const bottom = Math.max(completed.startY, completed.endY);
        if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) continue;
        const id = card.dataset.modelId;
        if (id && !catalog.selection.has(id)) {
          catalog.selection.add(id);
          catalog.anchor = id;
          changed = true;
        }
      }
      if (changed) {
        catalog.render();
        catalog.updateControls();
      }
    }

    document.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || state.testing
        || event.target.closest('button, input, select, textarea, details, summary, a, [contenteditable="true"]')) return;
      // Prevent lasso when clicking inside dialogs
      if (event.target.closest('[role="dialog"], .setup-dialog')) return;
      lasso = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        endX: event.clientX,
        endY: event.clientY,
        active: false,
      };
      document.body.classList.add('is-lasso-pressed');
    });

    document.addEventListener('pointermove', (event) => {
      if (!lasso || event.pointerId !== lasso.pointerId) return;
      if (!lasso.active) {
        const dx = event.clientX - lasso.startX;
        const dy = event.clientY - lasso.startY;
        if (dx * dx + dy * dy < 36) return;
        lasso.active = true;
        document.body.classList.add('is-lassoing');
      }
      lasso.endX = event.clientX;
      lasso.endY = event.clientY;
      renderLassoRect();
      event.preventDefault();
    });

    document.addEventListener('pointerup', (event) => {
      if (!lasso || event.pointerId !== lasso.pointerId) return;
      lasso.endX = event.clientX;
      lasso.endY = event.clientY;
      const wasActive = lasso.active;
      renderLassoRect();
      finishLasso();
      if (wasActive) {
        suppressLassoClick = true;
        clearTimeout(clearLassoClickSuppression);
        clearLassoClickSuppression = setTimeout(() => { suppressLassoClick = false; }, 0);
      }
    });
    document.addEventListener('pointercancel', (event) => {
      if (lasso?.pointerId === event.pointerId) finishLasso();
    });

    function appendCardResult(card, result) {
      if (!result) return;
      const box = document.createElement('div');
      box.className = `card-result${result.status === 'success' ? ' good' : result.status === 'failed' ? ' bad' : ''}`;
      const stateLabel = document.createElement('div');
      stateLabel.className = 'result-state';
      const labels = { queued: '等待测试', running: '测试中', success: '测试成功', failed: '测试失败', stopped: '已停止' };
      stateLabel.textContent = `${labels[result.status] || result.status}${result.elapsed === undefined ? '' : ` · ${result.elapsed.toFixed(1)} 秒`}`;
      box.append(stateLabel);

      if (result.status === 'success') {
        const answer = result.answer || '模型返回了空内容。';
        const preview = document.createElement('p');
        preview.textContent = answer.slice(0, 280);
        box.append(preview);
        if (answer.length > 280) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = '查看完整回复';
          const fullAnswer = document.createElement('p');
          fullAnswer.textContent = answer;
          details.append(summary, fullAnswer);
          box.append(details);
        }
      } else if (result.status === 'failed') {
        const error = typeof result.error === 'string'
          ? { summary: result.error, details: '' }
          : result.error;
        const preview = document.createElement('p');
        preview.textContent = error.summary;
        box.append(preview);
        if (error.details) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = '查看技术详情';
          const technicalDetails = document.createElement('p');
          technicalDetails.textContent = error.details;
          details.append(summary, technicalDetails);
          box.append(details);
        }
      }
      card.append(box);
    }

    function formatTokens(value) {
      const count = Number(value);
      return Number.isFinite(count) && count > 0 ? `${count.toLocaleString()} tokens` : '';
    }

    function modalityLabel(value) {
      const labels = { text: '文本', image: '图片', video: '视频', audio: '音频' };
      return labels[value] || value;
    }

    function capabilityLabel(value) {
      const labels = {
        reasoning: '推理',
        coding: '编程',
        longctx: '长上下文',
        general: '通用',
        agentic: 'Agent',
        benchmark: '基准测试',
        speed: '速度',
        small: '轻量',
        multimodal: '多模态',
        vision: '视觉',
        router: '自动路由',
        safety: '内容安全',
      };
      return labels[value] || value;
    }

    function appendMeta(card, label, value) {
      if (!value) return;
      const item = document.createElement('p');
      item.className = 'meta';
      item.textContent = `${label}：${value}`;
      card.append(item);
    }

    async function copyText(text) {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {
          // Fall back for browsers that expose the Clipboard API but deny permission.
        }
      }

      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('浏览器不允许访问剪贴板');
    }

    function setupBaseUrl(client) {
      const base = window.location.origin.replace(/\/+$/, '');
      return ['claude-code', 'cc-switch-claude'].includes(client) ? base : `${base}/v1`;
    }

    const SETUP_CLIENT_GROUPS = {
      '聊天与办公': ['chatbox', 'cherry-studio', 'workbuddy', 'loomy', 'workswarm', 'qclaw'],
      '编程助手': ['cline', 'continue-json', 'trae', 'deepseek-harness', 'opencode', 'hermes-agent', 'openfic', 'github-copilot-byok', 'vscode-copilot-chat', 'claude-code'],
      '配置切换器': ['cc-switch-claude', 'cc-switch-codex'],
      '其他': ['openai-compatible'],
    };
    const SETUP_CLIENT_META = {
      'claude-code': { icon: 'CC', description: '通过 Anthropic Messages 接口连接 Claude Code。', protocol: 'Anthropic' },
      cline: { icon: 'CL', description: '在 Cline 的自定义提供方表单中填写 OpenAI 兼容接口。', protocol: 'OpenAI 兼容' },
      'continue-json': { icon: 'CO', description: '将生成的模型条目合并到 Continue 配置文件。', protocol: '配置文件' },
      chatbox: { icon: 'CB', description: '在 Chatbox 添加自定义供应商并选择模型。', protocol: 'OpenAI 兼容' },
      'cherry-studio': { icon: 'CS', description: '在 Cherry Studio 添加供应商并获取或选择模型。', protocol: 'OpenAI 兼容' },
      workbuddy: { icon: 'WB', description: '在 WorkBuddy 的智能体模型管理中添加自定义模型。', protocol: 'OpenAI 兼容' },
      trae: { icon: 'TR', description: '登录 Trae 后添加自定义模型，保存后在对话中选择。', protocol: 'OpenAI 兼容' },
      'deepseek-harness': { icon: 'DH', description: '添加自定义模型 API，并从接口获取可用模型。', protocol: 'OpenAI 兼容' },
      'cc-switch-claude': { icon: 'CC', description: '通过 CC-Switch 管理 Claude Code 的自定义供应商。', protocol: 'Anthropic' },
      opencode: { icon: 'OC', description: '添加自定义提供商，再将模型加入 OpenCode。', protocol: 'OpenAI 兼容' },
      workswarm: { icon: 'WS', description: '在 WorkSwarm 模型配置中添加 OpenAI 供应商。', protocol: 'OpenAI 兼容' },
      loomy: { icon: 'LO', description: '添加服务商，获取模型后应用到 Loomy。', protocol: 'OpenAI 兼容' },
      'hermes-agent': { icon: 'HA', description: '添加自定义端点，再从模型列表中选择。', protocol: 'OpenAI 兼容' },
      openfic: { icon: 'OF', description: '先创建连接，再添加语言模型。', protocol: 'OpenAI 兼容' },
      'github-copilot-byok': { icon: 'GH', description: '使用 GitHub Copilot 的自带密钥功能添加模型。', protocol: 'Chat Completions' },
      'vscode-copilot-chat': { icon: 'VS', description: '从 VS Code Copilot Chat 的模型管理中添加自定义端点。', protocol: 'Chat Completions' },
      qclaw: { icon: 'Q', description: '在 QClaw 的自定义大模型页面填写连接信息。', protocol: 'OpenAI 兼容' },
      'cc-switch-codex': { icon: 'CX', description: '通过 CC-Switch 配置并路由到 Codex。', protocol: 'Codex' },
      'openai-compatible': { icon: 'API', description: '用于支持 OpenAI 兼容接口的其他客户端。', protocol: 'OpenAI 兼容' },
    };

    function renderSetupClients() {
      const list = $('#setup-client-list');
      const selected = $('#setup-client').value;
      const query = $('#setup-client-search').value.trim().toLowerCase();
      list.replaceChildren();
      for (const [group, clientIds] of Object.entries(SETUP_CLIENT_GROUPS)) {
        const options = clientIds
          .map((id) => $('#setup-client').querySelector(`option[value="${id}"]`))
          .filter((option) => option && option.textContent.toLowerCase().includes(query));
        if (!options.length) continue;
        const section = document.createElement('section');
        section.className = 'setup-client-group';
        const heading = document.createElement('h4');
        heading.className = 'setup-client-group-title';
        heading.textContent = group;
        section.append(heading);
        for (const option of options) {
          const meta = SETUP_CLIENT_META[option.value];
          const button = document.createElement('button');
          button.className = 'setup-client-option';
          button.type = 'button';
          button.dataset.client = option.value;
          button.setAttribute('aria-current', String(option.value === selected));
          button.setAttribute('aria-label', option.textContent);
          const icon = document.createElement('span');
          icon.className = 'setup-client-icon';
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = meta.icon;
          const name = document.createElement('span');
          name.className = 'setup-client-name';
          name.textContent = option.textContent;
          button.append(icon, name);
          button.addEventListener('click', () => {
            $('#setup-client').value = option.value;
            $('#setup-client').dispatchEvent(new Event('change'));
          });
          section.append(button);
        }
        list.append(section);
      }
      if (!list.childElementCount) {
        const empty = document.createElement('p');
        empty.className = 'setup-client-group-title';
        empty.textContent = '没有匹配的客户端';
        list.append(empty);
      }
      list.querySelector('.setup-client-option[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function shellQuote(value, shell) {
      if (shell === 'powershell') return `'${value.replace(/'/g, "''")}'`;
      return `'${value.replace(/'/g, "'\\''")}'`;
    }

    function setupConfiguration({ maskKey = false } = {}) {
      const client = $('#setup-client').value;
      const baseUrl = $('#setup-base-url').value.trim();
      const apiKey = $('#setup-api-key').value.trim() || 'dummy';
      const model = $('#setup-model-id').value;
      const visibleKey = maskKey && apiKey !== 'dummy' ? '••••••••' : apiKey;
      if (client === 'claude-code') {
        return [
          '# 在 PowerShell 当前终端中运行，然后启动 Claude Code',
          `$env:ANTHROPIC_BASE_URL = ${shellQuote(baseUrl, 'powershell')}`,
          `$env:ANTHROPIC_AUTH_TOKEN = ${shellQuote(visibleKey, 'powershell')}`,
          `$env:ANTHROPIC_MODEL = ${shellQuote(model, 'powershell')}`,
          'claude',
          '',
          '# macOS / Linux（bash 或 zsh）',
          `export ANTHROPIC_BASE_URL=${shellQuote(baseUrl, 'shell')}`,
          `export ANTHROPIC_AUTH_TOKEN=${shellQuote(visibleKey, 'shell')}`,
          `export ANTHROPIC_MODEL=${shellQuote(model, 'shell')}`,
          'claude',
        ].join('\n');
      }
      if (client === 'continue-json') {
        return JSON.stringify({
          models: [{
            title: model,
            provider: 'openai',
            model,
            apiKey: visibleKey,
            apiBase: baseUrl,
          }],
        }, null, 2);
      }
      const fieldLines = [
        `Base URL：${baseUrl}`,
        `API Key：${visibleKey}`,
        `Model ID：${model}`,
      ];
      if (client === 'chatbox') {
        return ['供应商类型：自定义 OpenAI 兼容', '供应商名称：easyAI 本地网关', ...fieldLines].join('\n');
      }
      if (client === 'cherry-studio') {
        return ['供应商名称：easyAI 本地网关', ...fieldLines, '模型列表：填写 Model ID 或从服务端获取'].join('\n');
      }
      if (client === 'workbuddy') {
        return ['模型提供方：自定义模型（OpenAI 兼容）', ...fieldLines].join('\n');
      }
      if (client === 'trae') {
        return ['模型类型：自定义模型', '接口格式：OpenAI 兼容', `请求地址：${baseUrl}`, `模型 ID：${model}`, `API Key：${visibleKey}`].join('\n');
      }
      if (client === 'deepseek-harness') {
        return ['提供商类型：自定义模型 API', '协议：OpenAI 兼容', `接口地址：${baseUrl}`, `API Key：${visibleKey}`, `模型：从 API 获取后选择 ${model}`].join('\n');
      }
      if (client === 'cc-switch-claude') {
        return ['配置类型：自定义配置', '供应商名称：easyAI 本地网关', `请求地址：${baseUrl}`, `API Key：${visibleKey}`, `Claude 模型 ID：${model}`, '高级选项：使用 Anthropic Messages 认证与路由格式；按 CC-Switch 界面对应字段填写。'].join('\n');
      }
      if (client === 'opencode') {
        return ['自定义提供商 ID：easyai-local', '提供商名称：easyAI 本地网关', `Base URL：${baseUrl}`, `API Key：${visibleKey}`, `添加模型 ID：${model}`].join('\n');
      }
      if (client === 'workswarm') {
        return ['供应商：OpenAI', `模型名：${model}`, `别名：${model}`, `接口地址：${baseUrl}`, `API Key：${visibleKey}`].join('\n');
      }
      if (client === 'loomy') {
        return ['服务商 ID：easyai-local', '服务商名称：easyAI 本地网关', `接口地址：${baseUrl}`, `API Key：${visibleKey}`, `从 API 获取模型后选择：${model}`].join('\n');
      }
      if (client === 'hermes-agent') {
        return ['提供方：自定义端点', `接口地址：${baseUrl}`, `API Key：${visibleKey}`, `配置后选择模型：${model}`].join('\n');
      }
      if (client === 'openfic') {
        return ['连接类型：OpenAI 兼容', `服务 URL：${baseUrl}`, `API Key：${visibleKey}`, '模型类型：语言模型', `模型 ID：${model}`].join('\n');
      }
      if (client === 'github-copilot-byok') {
        return ['模式：使用自己的 API 密钥', '传输格式：Chat Completions', `接口地址：${baseUrl}`, `API Key：${visibleKey}`, `模型 ID：${model}`].join('\n');
      }
      if (client === 'vscode-copilot-chat') {
        return [`名称：${model}`, `模型 ID：${model}`, `API Key：${visibleKey}`, `接口地址：${baseUrl}`, '传输格式：按客户端默认值；如需选择，使用 Chat Completions。'].join('\n');
      }
      if (client === 'qclaw') {
        return ['类型：自定义大模型', `Base URL：${baseUrl}`, `模型名称：${model}`, `API Key：${visibleKey}`].join('\n');
      }
      if (client === 'cc-switch-codex') {
        return ['配置类型：自定义配置', '供应商名称：easyAI 本地网关', `接口地址：${baseUrl}`, `API Key：${visibleKey}`, `添加模型 ID：${model}`, '高级选项：上下文长度与推理强度按需设置（可先保留默认值）。', '应用：点击「路由到此」，再重启 Codex。'].join('\n');
      }
      if (client === 'cline') {
        return ['API 提供方：OpenAI Compatible', ...fieldLines].join('\n');
      }
      return [
        'API 提供方：OpenAI Compatible',
        ...fieldLines,
      ].join('\n');
    }

    function updateSetupDialog() {
      const client = $('#setup-client').value;
      const option = $('#setup-client').selectedOptions[0];
      const meta = SETUP_CLIENT_META[client] || SETUP_CLIENT_META['openai-compatible'];
      $('#setup-base-url').value ||= setupBaseUrl(client);
      const instructions = {
        'claude-code': '在 Claude Code 所在的终端运行预览中的命令；环境变量只对当前终端会话生效。Base URL 不带 /v1，Claude Code 会请求 Anthropic Messages 接口。',
        cline: '打开 Cline 的 API 配置，选择 OpenAI Compatible，将下方 Base URL、API Key 和 Model ID 填入对应字段。Base URL 带 /v1。',
        'continue-json': '将下方 JSON 中的 models 条目合并到 Continue 的 config.json；不要覆盖已有其他模型。保存后在 Continue 中选择该模型。字段名请按当前 Continue 版本核对。',
        chatbox: '在 Chatbox 的模型提供方中添加自定义供应商，选择 OpenAI 兼容类型并填写下方字段；随后获取模型列表或手动添加 Model ID，再测试连接。',
        'cherry-studio': '在 Cherry Studio 设置中添加自定义供应商，填写 Base URL 和 API Key，获取或手动添加模型 ID，启用供应商并检测连接。',
        workbuddy: '在 WorkBuddy 的智能体设置 / 模型管理中添加自定义模型，选择自定义供应商，填写下方 Base URL、API Key 和模型名称后保存。教程标注仅支持 OpenAI 兼容接口；思考模式和工具调用等可选项按模型能力自行决定。127.0.0.1 仅在 WorkBuddy 请求从本机发出时可用。',
        trae: '先登录 Trae，进入「设置 → 模型 → 添加模型 → 自定义模型」。选择与网关相符的兼容格式，填写请求地址、模型 ID 和 API Key，保存后在对话中选择模型。请求地址不要在末尾多加斜杠。',
        'deepseek-harness': '进入「设置 → 模型 → 添加模型提供商」，选择自定义模型 API，使用 OpenAI 兼容协议并填写地址与 API Key。点击获取可用模型，然后选择当前模型。',
        'cc-switch-claude': '在 CC-Switch 中添加供应商并选择「自定义配置」，填写名称、请求地址和 API Key；打开高级选项，按下方摘要设置认证方式与路由格式。应用后在 Claude Code 终端发送一条简单消息验证。',
        opencode: '在 OpenCode 中选择「自定义提供商」，填写提供商 ID、名称、Base URL 和 API Key，再添加模型 ID。使用时在 OpenCode 中选择刚添加的模型。',
        workswarm: '进入「更多 → 模型配置」，供应商选 OpenAI。模型名和别名可使用相同值，填写接口地址和 API Key 后保存，再回到界面选择模型。',
        loomy: '进入「模型 → 服务商配置 → 添加服务商」，先填写 ID、名称和接口地址，再填写 API Key 并从 API 获取模型。选择该模型后点击应用。',
        'hermes-agent': '打开提供方设置，选择「自定义端点」，填写接口地址和 API Key 并保存；再进入模型列表选择对应模型。',
        openfic: '进入「连接 / 服务提供商 → 新建连接」，选择 OpenAI 兼容协议，填写服务 URL 和 API Key 并保存。之后新建语言模型，若列表没有模型就手动输入 Model ID。',
        'github-copilot-byok': '在 GitHub Copilot 的模型管理中选择「使用自己的 API 密钥」，传输格式选 Chat Completions，填写接口地址和 API Key，再添加 Model ID。此功能需要当前账号和客户端支持 BYOK。',
        'vscode-copilot-chat': '在 VS Code Copilot Chat 面板打开「管理模型 → 添加模型 / 自定义端点」，依次填写名称、Model ID、API Key 和接口地址；其他字段先保留默认值，保存后切换到该模型。',
        qclaw: '打开 QClaw 的「自定义大模型」，填写 Base URL、模型名称和 API Key，保存后回到对话选择该自定义模型。',
        'cc-switch-codex': '在 CC-Switch 选择「自定义配置」，填写地址与 API Key；添加模型并按需设置上下文长度、推理强度。点击「路由到此」，然后重启 Codex 使配置生效。',
        'openai-compatible': '在客户端的自定义提供方 / 模型设置中选择 OpenAI Compatible，并按下方字段填写。Base URL 需要带 /v1；具体字段名称以客户端版本为准。',
      };
      $('#setup-client-title').textContent = option?.textContent || '其他 OpenAI 兼容客户端';
      $('#setup-client-description').textContent = meta.description;
      $('#setup-protocol-badge').textContent = meta.protocol;
      $('#setup-instructions').textContent = instructions[client] || instructions['openai-compatible'];
      $('#workbuddy-skill-tools').classList.toggle('hidden', client !== 'workbuddy');
      $('#workbuddy-skill-status').textContent = '';
      $('#setup-preview').value = setupConfiguration({ maskKey: true });
      $('#setup-status').textContent = '';
      renderSetupClients();
    }

    // Ctrl+A 全选 - 使用当前活动的 catalog
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
      if (event.target instanceof HTMLElement
        && (event.target.isContentEditable || event.target.matches('input:not([type="checkbox"]), textarea, select'))) return;
      const catalog = getActiveCatalog();
      if (!catalog || catalog.testing) return;
      event.preventDefault();
      catalog.selectAll();
    });

    // 共享选择 Dock 事件处理 - 使用当前活动的 catalog
    $('#dock-clear-button').addEventListener('click', () => {
      const catalog = getActiveCatalog();
      if (catalog) catalog.clearSelection();
    });
    $('#dock-test-button').addEventListener('click', () => {
      const catalog = getActiveCatalog();
      if (catalog) catalog.runTests();
    });
    $('#dock-stop-button').addEventListener('click', () => {
      const catalog = getActiveCatalog();
      if (catalog) catalog.stop();
    });

    // Ctrl+Enter 开始测试 - 使用当前活动的 catalog
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
      const catalog = getActiveCatalog();
      if (!catalog || catalog.testing || !catalog.selection.size) return;
      event.preventDefault();
      catalog.runTests();
    });

    $('#save-key').addEventListener('click', () => {
      state.key = $('#local-key').value.trim();
      if (state.key) sessionStorage.setItem('gateway-local-key', state.key);
      else sessionStorage.removeItem('gateway-local-key');
      $('#local-key-status').textContent = state.key
        ? '口令已在当前标签页保存，正在重新连接…'
        : '已清除本地访问口令，正在重新连接…';
      kiloCatalog.load();
    });
    $('#dock-prompt-button').addEventListener('click', () => {
      const catalog = getActiveCatalog();
      if (!catalog) return;
      const prompt = $(catalog.sels.testPrompt);
      const promptPanel = prompt.closest('details');
      if (promptPanel) promptPanel.open = true;
      prompt.scrollIntoView({ behavior: 'smooth', block: 'center' });
      prompt.focus({ preventScroll: true });
    });
    $('#refresh').addEventListener('click', () => kiloCatalog.load());
    $('#search').addEventListener('input', () => {
      const catalog = getActiveCatalog();
      if (catalog) catalog.render();
    });
    $('#free-only').addEventListener('change', () => {
      const catalog = getActiveCatalog();
      if (catalog) catalog.render();
    });
    // Setup dialog accessibility: return focus to trigger element on close
    let setupDialogTrigger = null;
    function openSetupDialog(model, provider) {
      setupDialogTrigger = document.activeElement; // Save element that opened dialog
      $('#setup-model-label').textContent = `当前模型：${model.id}`;
      $('#setup-model-id').value = model.id;
      // 预填 Base URL 和 API Key 根据上游来源
      if (['sensenova', 'internlm', 'scnet'].includes(provider)) {
        $('#setup-base-url').value = setupBaseUrl('claude-code');
        $('#setup-api-key').value = state.key || 'dummy';
        $('#setup-api-key').readOnly = false;
      } else {
        // Kilo / 其他
        $('#setup-base-url').value = setupBaseUrl('claude-code');
        $('#setup-api-key').value = state.key || 'dummy';
        $('#setup-api-key').readOnly = false;
      }
      $('#setup-client').value = 'claude-code';
      updateSetupDialog();
      $('#setup-dialog').showModal();
      // Focus first focusable element in dialog
      const firstFocusable = $('#setup-dialog').querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      firstFocusable?.focus();
    }

    $('#setup-dialog').addEventListener('close', () => {
      // Return focus to element that opened the dialog
      if (setupDialogTrigger && typeof setupDialogTrigger.focus === 'function') {
        setupDialogTrigger.focus();
      }
      setupDialogTrigger = null;
      // Reset readonly state
      $('#setup-api-key').readOnly = false;
    });

    $('#close-setup').addEventListener('click', () => $('#setup-dialog').close());
    $('#setup-client').addEventListener('change', () => {
      $('#setup-base-url').value = setupBaseUrl($('#setup-client').value);
      updateSetupDialog();
    });

    // Tab panels accessibility: add tabindex and focus on switch
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.setAttribute('tabindex', '0');
    });

    $('#setup-client-search').addEventListener('input', renderSetupClients);
    $('#setup-api-key').addEventListener('input', updateSetupDialog);
    $('#copy-workbuddy-skill').addEventListener('click', async () => {
      const status = $('#workbuddy-skill-status');
      try {
        const response = await fetch('/api/workbuddy-skill', { headers: apiHeaders() });
        if (!response.ok) throw new Error(`下载指令失败（HTTP ${response.status}）`);
        const skill = await response.text();
        const prompt = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
        if (!prompt) throw new Error('Skill 内容为空');
        const keyInstruction = state.key
          ? '我已设置本机访问口令；请不要在聊天中索取或输出口令，让我直接在 WorkBuddy 的 API Key 密码框中输入。'
          : '本机未设置访问口令，API Key 使用 dummy。';
        const request = [
          '请按以下说明帮我配置 WorkBuddy。',
          `本次选择的模型 ID：${$('#setup-model-id').value}`,
          `Base URL：${setupBaseUrl('workbuddy')}`,
          keyInstruction,
          '',
          prompt,
        ].join('\n');
        await copyText(request);
        status.textContent = '已复制。现在打开 WorkBuddy 对话框并粘贴即可；其中不包含你的 API Key。';
      } catch (error) {
        status.textContent = error.message || '复制失败，请重试。';
      }
    });
    $('#download-workbuddy-skill').addEventListener('click', async () => {
      const status = $('#workbuddy-skill-status');
      try {
        const response = await fetch('/api/workbuddy-skill.zip', { headers: apiHeaders() });
        if (!response.ok) throw new Error(`下载 Skill 失败（HTTP ${response.status}）`);
        const archive = await response.blob();
        const url = URL.createObjectURL(archive);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'configure-workbuddy-easyai-model.zip';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = 'ZIP 已下载。可在 WorkBuddy 的 Skill 入口上传这个文件。';
      } catch (error) {
        status.textContent = error.message || '下载失败，请重试。';
      }
    });
    $('#setup-copy').addEventListener('click', async () => {
      const status = $('#setup-status');
      try {
        await navigator.clipboard.writeText(setupConfiguration());
        status.textContent = '配置已复制。请粘贴到对应客户端；包含口令时注意不要分享。';
      } catch (error) {
        status.textContent = `复制失败：${error.message || '浏览器不允许访问剪贴板'}。请手动复制上方预览。`;
      }
    });

    // Show each provider's model catalog only when its key is available in the unlocked vault.
    async function checkAndShowProviderSections() {
      const sensenovaConfigured = state.vault?.unlocked && state.vault?.providers?.find(p => p.id === 'sensenova' && p.configured);
      const internlmConfigured = state.vault?.unlocked && state.vault?.providers?.find(p => p.id === 'internlm' && p.configured);
      const scnetConfigured = state.vault?.unlocked && state.vault?.providers?.find(p => p.id === 'scnet' && p.configured);

      $('#sensenova-catalog-section').hidden = !sensenovaConfigured;
      $('#internlm-catalog-section').hidden = !internlmConfigured;
      $('#scnet-catalog-section').hidden = !scnetConfigured;
      $('#sensenova-flow').hidden = !!sensenovaConfigured;
      $('#internlm-flow').hidden = !!internlmConfigured;
      $('#scnet-flow').hidden = !!scnetConfigured;
    }

    // 在 renderVaultStatus 中调用 checkAndShowProviderSections
    const originalRenderVaultStatus = renderVaultStatus;
    renderVaultStatus = function() {
      originalRenderVaultStatus();
      checkAndShowProviderSections();
    };

    $('#open-sensenova').addEventListener('click', () => showView('sensenova'));
    $('#open-internlm').addEventListener('click', () => showView('internlm'));
    $('#open-scnet').addEventListener('click', () => showView('scnet'));
    $('#vault-open-sensenova').addEventListener('click', () => showView('sensenova'));
    $('#vault-open-internlm').addEventListener('click', () => showView('internlm'));
    $('#vault-open-scnet').addEventListener('click', () => showView('scnet'));
    document.querySelectorAll('[data-open-vault]').forEach((button) => {
      button.addEventListener('click', () => showView('vault'));
    });

    checkAndShowProviderSections();

    showView('home');
