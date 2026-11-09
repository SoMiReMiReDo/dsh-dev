window.__ModuleLoader__.load({id:'dsh-ppt-ultra',factory(require){
  const React=require('react'),h=React.createElement

  const css=`
  .pu{--ink:#182235;--ink-2:#3a475d;--muted:#6c798f;--faint:#95a0b3;--line:#e4e8f1;--line-soft:#edf0f6;--bg:#f2f4f9;--panel:#ffffff;--panel-2:#f8f9fc;--accent:#5a49d9;--accent-strong:#4a3ac8;--accent-2:#8b7bff;--accent-soft:#eeeaff;--accent-line:#cfc7ff;--ok:#13875a;--ok-soft:#e7f7ef;--warn:#a76a11;--warn-soft:#fdf3e2;--danger:#b23a2e;--danger-soft:#fdece9;--shadow-1:0 1px 2px rgba(23,34,54,.05);--shadow-2:0 8px 24px rgba(23,34,54,.09);--shadow-3:0 26px 70px rgba(23,34,54,.16);--radius:12px;color-scheme:light;position:relative;flex:1 1 auto;min-height:0;container-type:inline-size;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;text-align:left;-webkit-font-smoothing:antialiased}
  .pu *{box-sizing:border-box}
  .pu button,.pu input,.pu textarea,.pu select{font:inherit}
  .pu button{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;border:1px solid var(--line);border-radius:9px;padding:7px 12px;background:#fff;color:var(--ink-2);font-size:13px;font-weight:550;line-height:1.2;white-space:nowrap;box-shadow:var(--shadow-1);transition:border-color .16s,background .16s,color .16s,box-shadow .16s,transform .16s}
  .pu button:hover:not(:disabled){border-color:var(--accent-line);color:var(--accent);background:#fbfaff}
  .pu button:active:not(:disabled){transform:translateY(1px)}
  .pu button:focus-visible,.pu input:focus-visible,.pu textarea:focus-visible,.pu select:focus-visible{outline:2px solid rgba(90,73,217,.35);outline-offset:1px}
  .pu button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  .pu button.primary{background:linear-gradient(180deg,#6a58ec,#5a49d9);border-color:#5747d2;color:#fff;box-shadow:0 6px 16px rgba(90,73,217,.28)}
  .pu button.primary:hover:not(:disabled){background:linear-gradient(180deg,#5f4de5,#4a3ac8);border-color:#4a3ac8;color:#fff}
  .pu button.soft{background:var(--accent-soft);border-color:#ded7ff;color:var(--accent)}
  .pu button.soft:hover:not(:disabled){background:#e6e0ff;border-color:var(--accent);color:var(--accent)}
  .pu button.ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--muted)}
  .pu button.ghost:hover:not(:disabled){background:#f3f5fa;color:var(--ink);border-color:transparent}
  .pu .icon-btn{width:30px;height:30px;padding:0;border-radius:8px;box-shadow:none;color:var(--muted);background:transparent;border-color:transparent}
  .pu .icon-btn:hover:not(:disabled){background:#f1f3f8;color:var(--ink);border-color:transparent}
  .pu input,.pu textarea,.pu select{border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);padding:8px 10px;width:100%;font-size:13px;transition:border-color .16s,box-shadow .16s}
  .pu input:hover,.pu textarea:hover,.pu select:hover{border-color:#d3d9e5}
  .pu input:focus,.pu textarea:focus,.pu select:focus{border-color:var(--accent-line);box-shadow:0 0 0 3px rgba(90,73,217,.10);outline:none}
  .pu textarea{resize:vertical;min-height:78px;line-height:1.6}
  .pu input[type=checkbox]{width:auto;accent-color:var(--accent);box-shadow:none;margin:0}
  .pu small{color:var(--muted);font-size:12px}
  .pu label{display:block}
  .pu h1,.pu h2,.pu h3,.pu p{margin:0}
  .pu .row{display:flex;gap:8px;align-items:center}
  .pu .between{justify-content:space-between}
  .pu .grow{flex:1;min-width:0}
  .pu .muted{color:var(--muted)}
  .pu ::-webkit-scrollbar{width:10px;height:10px}
  .pu ::-webkit-scrollbar-track{background:transparent}
  .pu ::-webkit-scrollbar-thumb{background:#cfd6e3;border-radius:99px;border:3px solid transparent;background-clip:content-box}
  .pu ::-webkit-scrollbar-thumb:hover{background:#b4bed1;background-clip:content-box}
  /* ---------- 顶栏 ---------- */
  .pu .top{flex:none;height:60px;display:flex;align-items:center;gap:12px;padding:0 16px 0 22px;background:rgba(255,255,255,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}
  .pu .top-actions .sep{width:1px;height:20px;background:var(--line);flex:none;margin:0 2px}
  .pu .top-actions .exit-btn{color:var(--muted)}
  .pu .top-actions .exit-btn:hover:not(:disabled){background:#f3f5fa;border-color:transparent;color:var(--ink)}
  .pu .brand-row{display:flex;align-items:center;gap:9px;flex:none}
  .pu .logo{width:28px;height:28px;border-radius:9px;background:linear-gradient(145deg,#7b6bff,#4a3ac8);display:grid;place-items:center;color:#fff;box-shadow:0 4px 12px rgba(74,58,200,.32)}
  .pu .brand-text{display:flex;align-items:baseline;gap:3px;font-size:15.5px;font-weight:750;letter-spacing:-.2px;color:var(--ink);white-space:nowrap}
  .pu .brand-text span{color:var(--accent)}
  .pu .top-divider{width:1px;height:20px;background:var(--line);flex:none}
  .pu .top-doc{display:flex;align-items:center;gap:7px;min-width:0;flex:0 1 auto;color:var(--faint)}
  .pu .filename{font-size:13.5px;font-weight:650;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(44vw,540px)}
  .pu .filename.placeholder{font-weight:550;color:var(--faint)}
  .pu .top-status{display:flex;align-items:center;min-width:0;flex:1 1 auto}
  .pu .top-actions{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
  .pu .chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:550;padding:4px 10px;border-radius:99px;background:#f1f3f8;color:var(--muted);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .pu .chip.live{background:var(--accent-soft);color:var(--accent)}
  .pu .chip.warn{background:var(--warn-soft);color:var(--warn)}
  .pu .chip.ok{background:var(--ok-soft);color:var(--ok)}
  .pu .narrow-only{display:none}
  /* ---------- 进度与错误 ---------- */
  .pu .busybar{flex:none;height:2px;background:transparent;overflow:hidden;position:relative}
  .pu .busybar.on::before{content:'';position:absolute;top:0;bottom:0;width:38%;background:linear-gradient(90deg,transparent,var(--accent),var(--accent-2),transparent);border-radius:2px;animation:pu-load 1.15s ease-in-out infinite}
  .pu .error{flex:none;display:flex;align-items:center;gap:10px;padding:9px 18px;background:var(--danger-soft);border-bottom:1px solid #f3c8c1;color:var(--danger);font-size:13px}
  .pu .error .grow{overflow-wrap:anywhere}
  /* ---------- 布局 ---------- */
  .pu .layout{position:relative;display:grid;grid-template-columns:176px minmax(0,1fr) 352px;flex:1;min-height:0}
  .pu .layout.no-doc{grid-template-columns:minmax(0,1fr) 352px}
  .pu .pages{display:flex;flex-direction:column;min-height:0;background:var(--panel-2);border-right:1px solid var(--line)}
  .pu .pages-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 14px 10px}
  .pu .pages-head strong{font-size:12.5px;font-weight:700;letter-spacing:.02em}
  .pu .pages-head .count{font-size:11.5px;color:var(--faint);margin-left:6px;font-weight:500}
  .pu .thumbs{flex:1;min-height:0;overflow:auto;padding:2px 14px 18px}
  .pu .doc-switch{margin:0 14px 10px;width:calc(100% - 28px);font-size:12px;padding:6px 8px}
  .pu .thumb{display:block;width:100%;padding:0;margin:0 0 12px;border:0;background:transparent;box-shadow:none;border-radius:9px;text-align:left}
  .pu .thumb:hover{border-color:transparent;background:transparent;transform:none;color:inherit}
  .pu .thumb-card{position:relative;border-radius:8px;overflow:hidden;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow-1);transition:border-color .16s,box-shadow .16s}
  .pu .thumb:hover .thumb-card{border-color:#c6bdf3;box-shadow:var(--shadow-2)}
  .pu .thumb.active .thumb-card{border-color:var(--accent);box-shadow:0 0 0 2px rgba(90,73,217,.18),var(--shadow-2)}
  .pu .thumb .thumb-media{position:relative;width:100%;aspect-ratio:16/9;background:linear-gradient(180deg,#f7f8fc,#eef1f7);overflow:hidden}
  .pu .thumb .thumb-media img{display:block;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .18s}
  .pu .thumb .thumb-media img.show{opacity:1}
  .pu .thumb .thumb-state{position:absolute;inset:0;display:grid;place-items:center;color:var(--faint)}
  .pu .thumb .spinner{width:16px;height:16px;border-width:2px}
  .pu .thumb-meta{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:5px 3px 0}
  .pu .thumb-no{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  .pu .thumb.active .thumb-no{color:var(--accent);font-weight:650}
  .pu .thumb-badge{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--warn);background:var(--warn-soft);border-radius:99px;padding:1px 6px}
  .pu .center{display:flex;flex-direction:column;min-width:0;min-height:0}
  .pu .toolbar{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px;background:rgba(255,255,255,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .pu .page-indicator{display:flex;align-items:baseline;gap:6px;flex:none}
  .pu .page-indicator strong{font-size:13px;font-weight:700}
  .pu .page-indicator span{font-size:12px;color:var(--faint)}
  .pu .toolbar-spacer{flex:1 1 auto}
  .pu .seg{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:#eff1f7;flex:none}
  .pu .seg button{border:1px solid transparent;background:transparent;box-shadow:none;border-radius:7px;padding:5px 10px;font-size:12.5px;font-weight:550;color:var(--muted)}
  .pu .seg button:hover:not(:disabled){background:rgba(255,255,255,.7);color:var(--ink-2);border-color:transparent}
  .pu .seg button.active{background:#fff;color:var(--ink);box-shadow:var(--shadow-1)}
  .pu .zoom{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:#fff;flex:none}
  .pu .zoom button{width:26px;height:26px;padding:0;border:0;border-radius:7px;box-shadow:none;background:transparent;color:var(--muted);font-size:15px}
  .pu .zoom button:hover:not(:disabled){background:#f2f4f9;color:var(--ink);border-color:transparent}
  .pu .zoom-val{min-width:46px;text-align:center;font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .pu .marks{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);padding:4px 8px;border-radius:8px;user-select:none}
  .pu .marks:hover{background:#f3f5fa;color:var(--ink-2)}
  .pu .canvas-scroll{flex:1;min-height:0;overflow:auto;padding:26px 24px 44px;background:radial-gradient(circle at 1px 1px,rgba(27,42,70,.10) 1px,transparent 0) 0 0/22px 22px,linear-gradient(180deg,#f6f8fc,#eef1f8)}
  .pu .comparison{display:flex;flex-direction:column;align-items:center;gap:28px;min-width:100%;width:max-content;margin:0 auto}
  .pu .frame{display:flex;flex-direction:column}
  .pu .frame-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
  .pu .frame-title{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:650;color:var(--ink-2)}
  .pu .frame-title .mark{width:7px;height:7px;border-radius:50%;background:var(--ink-2);opacity:.55}
  .pu .frame.after .frame-title .mark{background:var(--accent);opacity:1}
  .pu .frame-chip{font-size:11px;padding:2px 8px;border-radius:99px;background:#fff;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .pu .frame-chip.accent{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
  .pu .slide{position:relative;background:#fff;border-radius:10px;overflow:hidden;box-shadow:var(--shadow-2);border:1px solid rgba(23,34,54,.06)}
  .pu .slide-img{position:absolute;inset:0}
  .pu .slide-img img{display:block;width:100%;height:100%;object-fit:contain;background:#fff;opacity:0;transition:opacity .22s ease}
  .pu .slide-img img.show{opacity:1}
  .pu .img-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center;background:linear-gradient(180deg,#fafbfe,#f2f5fa);color:var(--muted);font-size:12.5px;z-index:2}
  .pu .img-state .state-title{font-weight:650;color:var(--ink-2)}
  .pu .img-state .state-sub{color:var(--faint);font-size:12px;max-width:80%;overflow-wrap:anywhere}
  .pu .img-state .icon-wrap{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:#fff;color:var(--faint);box-shadow:var(--shadow-1)}
  .pu .hit{position:absolute;background:transparent;border:1px solid transparent;border-radius:4px;padding:0;min-width:0;min-height:0;box-shadow:none;z-index:3;transition:background .12s,border-color .12s}
  .pu .hit:hover{background:rgba(90,73,217,.07);border-color:rgba(90,73,217,.55);transform:none}
  .pu .hit.selected{border:2px solid var(--accent);background:rgba(90,73,217,.08)}
  .pu .hit.changed{border:1px dashed #e09a2b}
  .pu .hit.changed.selected{border:2px solid var(--accent)}
  .pu .render-missing{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:260px;padding:32px;border-radius:12px;border:1px dashed var(--line);background:#fff;color:var(--muted);text-align:center}
  /* ---------- 右侧面板 ---------- */
  .pu .side{display:flex;flex-direction:column;min-height:0;background:var(--panel);border-left:1px solid var(--line)}
  .pu .tabs{flex:none;display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--line)}
  .pu .tab{position:relative;border:0;background:transparent;box-shadow:none;border-radius:8px 8px 0 0;padding:8px 10px 12px;font-size:13px;font-weight:650;color:var(--muted)}
  .pu .tab:hover:not(:disabled){background:#f5f7fb;color:var(--ink-2);border-color:transparent}
  .pu .tab.active{background:transparent;color:var(--accent);border-color:transparent}
  .pu .tab.active:hover{background:transparent;color:var(--accent)}
  .pu .tab.active::after{content:'';position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--accent)}
  .pu .tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;margin-left:5px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:10.5px;font-weight:700}
  .pu .side-body{flex:1;min-height:0;overflow:auto;padding:16px 16px 26px}
  .pu .section{margin-bottom:20px}
  .pu .section.last{margin-bottom:0}
  .pu .section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
  .pu .section-head h3{font-size:12.5px;font-weight:700;color:var(--ink);letter-spacing:.01em}
  .pu .section-meta{font-size:11.5px;color:var(--faint);font-weight:500}
  .pu .section-hint{font-size:12px;color:var(--faint);line-height:1.6;margin-bottom:10px}
  .pu .object-list{max-height:200px;overflow:auto;padding-right:2px}
  .pu .object{display:flex;align-items:center;gap:8px;margin:4px 0;padding:6px 8px;border-radius:8px;background:#f7f8fc;border:1px solid transparent;transition:background .14s,border-color .14s;cursor:pointer}
  .pu .object:hover{background:#f1f3fa;border-color:var(--line)}
  .pu .object span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ink-2);flex:1;min-width:0}
  .pu .object small{flex:none;font-size:10.5px;color:var(--faint);background:#fff;border-radius:99px;padding:1px 6px;border:1px solid var(--line)}
  .pu .object input:disabled+span{color:var(--faint)}
  .pu .empty-ops{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 14px;border:1px dashed var(--line);border-radius:10px;background:#fbfcfe;text-align:center}
  .pu .empty-ops .icon-wrap{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
  .pu .empty-ops p{font-size:12px;color:var(--faint);line-height:1.6}
  .pu .ops{display:flex;flex-direction:column;gap:10px}
  .pu .op{border:1px solid var(--line);border-radius:11px;padding:11px 12px;background:#fff;box-shadow:var(--shadow-1)}
  .pu .op-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .pu .op-index{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:10.5px;font-weight:700;flex:none}
  .pu .op-head strong{font-size:12.5px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pu .op-target{font-size:11.5px;color:var(--faint);margin-bottom:8px;overflow-wrap:anywhere}
  .pu .op-target b{color:var(--muted);font-weight:600}
  .pu .op small{display:block;margin:2px 0 6px}
  .pu .op .row label{flex:1}
  .pu .op .row small{margin:0 0 4px}
  .pu .op input[type=number]{margin-top:0}
  .pu .file-pill{display:flex;align-items:center;justify-content:center;gap:6px;border:1px dashed #cfc7f5;background:#faf8ff;border-radius:9px;padding:9px 12px;font-size:12px;color:var(--accent);cursor:pointer;transition:border-color .16s,background .16s}
  .pu .file-pill:hover{border-color:var(--accent);background:#f4f0ff}
  .pu .add{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
  .pu .add button{font-size:12px;padding:7px 8px;background:#fbfcfe;box-shadow:none}
  .pu .check{padding:10px 12px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;font-size:12px;background:#fff;line-height:1.6}
  .pu .check .check-level{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;margin-bottom:4px;color:var(--muted)}
  .pu .check .check-msg{color:var(--ink-2);overflow-wrap:anywhere}
  .pu .check.warning,.pu .check.review{background:var(--warn-soft);border-color:#f2dfb8}
  .pu .check.warning .check-level,.pu .check.review .check-level{color:var(--warn)}
  .pu .check.error{background:var(--danger-soft);border-color:#f3c8c1}
  .pu .check.error .check-level{color:var(--danger)}
  .pu .check.pass{background:var(--ok-soft);border-color:#c6e9d8}
  .pu .check.pass .check-level{color:var(--ok)}
  .pu .check button{margin-top:6px;font-size:11.5px;padding:4px 8px}
  .pu .warn-card{border:1px solid #f2dfb8;background:var(--warn-soft);border-radius:11px;padding:12px;margin-bottom:16px}
  .pu .warn-card strong{display:block;font-size:12.5px;margin-bottom:8px;color:var(--warn)}
  .pu .warn-card button{width:100%;margin-top:6px;font-size:12px;background:#fff}
  .pu .history{display:flex;flex-direction:column;gap:10px}
  .pu .round{border:1px solid var(--line);border-radius:11px;padding:11px 12px;background:#fff}
  .pu .round-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
  .pu .round-head strong{font-size:12.5px}
  .pu .round-head small{font-size:11px;color:var(--faint)}
  .pu .round button{width:100%;margin-top:6px;justify-content:flex-start;font-size:11.5px;padding:6px 8px;background:#fbfcfe;box-shadow:none;font-weight:550}
  .pu .footer{flex:none;display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-top:1px solid var(--line);background:linear-gradient(180deg,#fff,#fbfcfe)}
  .pu .footer .confirm{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;color:var(--muted);line-height:1.5;padding:2px;cursor:pointer}
  .pu .footer .confirm input{margin-top:2px;flex:none}
  .pu .footer-actions{display:grid;grid-template-columns:1fr 1.25fr;gap:8px}
  .pu .footer .text-action{align-self:center;font-size:11.5px;padding:3px 6px;color:var(--faint)}
  .pu .footer .text-action:hover:not(:disabled){color:var(--danger);background:var(--danger-soft);border-color:transparent}
  .pu .spinner{width:34px;height:34px;border-radius:50%;border:3px solid #ded7ff;border-top-color:var(--accent);animation:pu-spin .85s linear infinite;flex:none}
  .pu .spinner.sm{width:14px;height:14px;border-width:2px}
  .pu .spinner.md{width:22px;height:22px;border-width:2.5px}
  /* ---------- 右侧：文件选择 / 对话 ---------- */
  .pu .panel-body{flex:1;min-height:0;display:flex;flex-direction:column}
  .pu .panel-pane{flex:1;min-height:0;display:flex;flex-direction:column}
  .pu .file-pane{gap:8px;padding:12px 12px 16px;overflow:auto}
  .pu .file-bar{display:flex;align-items:center;gap:6px;flex:none}
  .pu .file-bar select{flex:1;min-width:0;font-size:12px;padding:6px 8px}
  .pu .file-bar .icon-btn{width:28px;height:28px;flex:none}
  .pu .crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:11px;color:var(--faint);flex:none}
  .pu .crumbs button{border:0;background:transparent;box-shadow:none;padding:2px 4px;border-radius:5px;color:var(--muted);font-size:11px;min-width:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pu .crumbs button:hover:not(:disabled){background:#f3f5fa;color:var(--ink);border-color:transparent}
  .pu .crumbs .sep{opacity:.6}
  .pu .files{display:flex;flex-direction:column;gap:2px;min-height:0}
  .pu .file-row{display:flex;align-items:center;gap:8px;justify-content:flex-start;min-width:0;width:100%;padding:6px 8px;border-radius:8px;border:1px solid transparent;background:transparent;box-shadow:none;font-size:12px;font-weight:500;color:var(--ink-2);text-align:left}
  .pu .file-row:hover:not(:disabled){background:#f5f7fb;border-color:var(--line);color:var(--ink)}
  .pu .file-row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pu .file-row .meta{flex:none;font-size:10.5px;color:var(--faint);font-weight:500}
  .pu .file-row.current{border-color:var(--accent-line);background:var(--accent-soft);color:var(--ink)}
  .pu .file-row.current .meta{color:var(--accent)}
  .pu .file-note{padding:14px 10px;text-align:center;font-size:11.5px;color:var(--faint);line-height:1.7}
  .pu .file-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:6px}
  .pu .file-option{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer;line-height:1.5}
  .pu .file-option input{margin:0;flex:none}
  .pu .chat-pane{flex:1;min-height:0;display:flex;flex-direction:column}
  .pu .chat-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 4px}
  .pu .chat-head .who{flex:1;min-width:0;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pu .chat-head .who strong{display:block;font-size:12.5px;color:var(--ink);font-weight:700}
  .pu .chat-head button{flex:none;font-size:11.5px;padding:4px 9px}
  .pu .chat-hint{flex:none;padding:0 12px 6px;font-size:10.5px;color:var(--faint);line-height:1.5}
  .pu .chat-log{flex:1;min-height:0;overflow:auto;padding:4px 12px 8px;display:flex;flex-direction:column;gap:10px}
  .pu .msg{display:flex;flex-direction:column;gap:3px;max-width:100%}
  .pu .msg.user{align-items:flex-end}
  .pu .msg .who{font-size:10.5px;color:var(--faint);padding:0 2px}
  .pu .msg .body{font-size:12.5px;line-height:1.62;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 10px;border-radius:10px;background:#f4f6fb;color:var(--ink-2);border:1px solid var(--line-soft)}
  .pu .msg.user .body{background:var(--accent-soft);border-color:#e2dcff;color:var(--ink)}
  .pu .msg.assistant .body{background:#fff;border-color:var(--line)}
  .pu .chat-empty{padding:22px 14px;color:var(--faint);font-size:12px;line-height:1.8;text-align:center}
  .pu .typing{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);padding:2px}
  .pu .proposal-card{flex:none;margin:8px 12px 0;padding:10px 11px;border:1px solid var(--accent-line);border-radius:11px;background:var(--accent-soft)}
  .pu .proposal-card>strong{font-size:12px;color:var(--accent-strong)}
  .pu .proposal-card .sub{display:block;font-size:10.5px;color:var(--muted);margin-top:2px}
  .pu .proposal-card .checks{display:flex;flex-direction:column;gap:3px;margin:7px 0;max-height:88px;overflow:auto}
  .pu .proposal-card .check-line{font-size:10.5px;color:var(--ink-2);line-height:1.5}
  .pu .proposal-card .check-line.warning{color:var(--warn)}
  .pu .proposal-card .check-line.error{color:var(--danger)}
  .pu .proposal-card .confirm{display:flex;align-items:flex-start;gap:6px;font-size:10.5px;color:var(--muted);line-height:1.5;margin:2px 0 8px;cursor:pointer}
  .pu .proposal-card .actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .pu .proposal-card button{font-size:11.5px;padding:6px 8px}
  .pu .history-line{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px 0;font-size:10.5px;color:var(--faint)}
  .pu .history-line button{font-size:10.5px;padding:3px 7px;margin-left:auto}
  .pu .chat-clarify{flex:none;margin:8px 12px 0}
  .pu .chat-clarify button{width:100%;margin-top:6px;font-size:11.5px;padding:5px 8px;background:#fff}
  .pu .chat-composer{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 12px 12px;border-top:1px solid var(--line-soft);background:#fff}
  .pu .chat-composer .row{display:flex;align-items:flex-end;gap:8px}
  .pu .chat-composer textarea{min-height:42px;max-height:132px;font-size:12.5px;padding:8px 9px;resize:none}
  .pu .send-btn{width:34px;height:34px;padding:0;flex:none;border-radius:10px;background:linear-gradient(180deg,#6a58ec,#5a49d9);border-color:#5747d2;color:#fff;box-shadow:0 5px 14px rgba(90,73,217,.24)}
  .pu .send-btn:hover:not(:disabled){background:linear-gradient(180deg,#5f4de5,#4a3ac8);border-color:#4a3ac8;color:#fff}
  .pu .send-btn.stop{background:#fff;border-color:var(--line);color:var(--danger);box-shadow:none}
  .pu .welcome-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;margin-top:4px}
  .pu .welcome-actions .dropzone-mini{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:9px;border:1px dashed #c4bbf2;background:#fff;color:var(--accent);font-size:12.5px;font-weight:600;cursor:pointer}
  .pu .welcome-actions .dropzone-mini:hover{border-color:var(--accent);background:#faf8ff}
  .pu .welcome-actions .dropzone-mini input{display:none}

  /* ---------- 欢迎 / 加载 ---------- */
  .pu .welcome{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:40px 24px;overflow:auto;background:radial-gradient(58% 44% at 50% 0%,rgba(90,73,217,.10),transparent 72%),radial-gradient(40% 36% at 88% 92%,rgba(139,123,255,.10),transparent 70%)}
  .pu .welcome-inner{width:min(660px,100%);display:flex;flex-direction:column;align-items:center;text-align:center;animation:pu-fade .3s ease both}
  .pu .eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:650;letter-spacing:.06em;color:var(--accent);background:var(--accent-soft);border:1px solid #e2dcff;border-radius:99px;padding:5px 12px}
  .pu .welcome-title{font-size:34px;line-height:1.22;letter-spacing:-1.1px;font-weight:750;margin:20px 0 12px;background:linear-gradient(115deg,#1c2740 12%,#4a3ac8 92%);-webkit-background-clip:text;background-clip:text;color:transparent}
  .pu .welcome-sub{font-size:14px;color:var(--muted);margin-bottom:28px;max-width:460px;line-height:1.7}
  .pu .dropzone{width:100%;display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 28px;border:1.5px dashed #c4bbf2;border-radius:20px;background:linear-gradient(180deg,#fbf9ff,#f3efff);cursor:pointer;transition:border-color .18s,box-shadow .18s,background .18s,transform .18s}
  .pu .dropzone:hover,.pu .dropzone.drag{border-color:var(--accent);background:linear-gradient(180deg,#f8f5ff,#eee8ff);box-shadow:0 16px 44px rgba(90,73,217,.15);transform:translateY(-1px)}
  .pu .dropzone input{display:none}
  .pu .dz-icon{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:#fff;color:var(--accent);box-shadow:var(--shadow-2);margin-bottom:4px}
  .pu .dropzone strong{font-size:15px;font-weight:650;color:var(--ink)}
  .pu .dz-sub{font-size:12px;color:var(--faint)}
  .pu .dz-cta{display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:8px 18px;border-radius:9px;background:linear-gradient(180deg,#6a58ec,#5a49d9);color:#fff;font-size:13px;font-weight:600;box-shadow:0 8px 20px rgba(90,73,217,.28)}
  .pu .loading-box{width:100%;display:flex;flex-direction:column;align-items:center;gap:10px;padding:36px 28px;border:1px solid var(--accent-line);border-radius:20px;background:linear-gradient(180deg,#fcfbff,#f4f1ff);box-shadow:0 16px 48px rgba(90,73,217,.10)}
  .pu .loading-box strong{font-size:17px;font-weight:700;color:var(--ink)}
  .pu .loading-file{max-width:92%;font-size:12.5px;color:var(--ink-2);background:#fff;border:1px solid var(--line);border-radius:99px;padding:3px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pu .loading-phase{font-size:12.5px;color:var(--muted)}
  .pu .loading-hint{font-size:11.5px;color:var(--faint);line-height:1.7}
  .pu .welcome-foot{margin-top:18px;font-size:12px;color:var(--faint)}
  .pu .welcome-warn{width:min(520px,100%);text-align:left;margin:0;line-height:1.7}
  .pu .welcome-warn strong{font-size:13px}
  .pu .welcome-warn span{display:block;font-size:12px;color:var(--ink-2);margin-top:4px}
  .pu .boot{flex:1;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--muted);font-size:13px}
  @keyframes pu-spin{to{transform:rotate(360deg)}}
  @keyframes pu-load{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
  @keyframes pu-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  /* macOS 桌面为窗口顶部条留出空间；Windows 的标题栏已由 DSH AppFrame 让出。 */
  html[data-platform=darwin] .pu{padding-top:var(--dsh-frame-top-clearance,0px)}
  /* 页面宽度由 DSH 侧栏/右侧栏决定，用容器查询而不是视口宽度 */
  @container (max-width:1180px){.pu .layout{grid-template-columns:158px minmax(0,1fr) 326px}.pu .top-doc .filename{max-width:min(34vw,320px)}}
  @container (max-width:980px){.pu .layout{grid-template-columns:104px minmax(0,1fr)}.pu .layout.no-doc{grid-template-columns:minmax(0,1fr)}.pu .side{position:absolute;right:0;top:0;bottom:0;width:min(360px,90vw);z-index:30;box-shadow:-18px 0 50px rgba(23,34,54,.18);border-left:1px solid var(--line);border-radius:0}.pu .side.collapsed{display:none}.pu .narrow-only{display:inline-flex}.pu .thumbs{padding:2px 8px 16px}.pu .pages-head{padding:12px 10px 8px}.pu .doc-switch{margin:0 8px 8px;width:calc(100% - 16px)}.pu .top-doc .filename{max-width:min(30vw,260px)}.pu .top-status{display:none}.pu .canvas-scroll{padding:18px 14px 36px}.pu .welcome-title{font-size:28px}}
  @container (max-width:720px){.pu .toolbar{gap:8px;padding:8px 10px}.pu .toolbar-spacer{display:none}.pu .top{padding:0 10px;gap:8px}.pu .brand-text{display:none}.pu .top-actions .exit-btn .exit-label{display:none}.pu .welcome{padding:28px 14px}.pu .welcome-title{font-size:25px}.pu .dropzone{padding:26px 18px}.pu .layout{grid-template-columns:84px minmax(0,1fr)}}
  `
  const iconPaths={
    file:['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z','M14 3v5h5'],
    plus:['M12 5v14','M5 12h14'],
    close:['M6 6l12 12','M18 6L6 18'],
    panel:['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z','M15 3v18'],
    check:['M4 12l5 5L20 6'],
    undo:['M9 14L4 9l5-5','M4 9h9a5 5 0 0 1 0 10h-1'],
    sparkle:['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z','M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z'],
    alert:['M12 9v4','M12 17h.01','M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
    image:['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z','M4 16l4.5-4.5a2 2 0 0 1 2.8 0L16 16','M14 14l1.8-1.8a2 2 0 0 1 2.8 0L20 13.5','M15 9h.01'],
    text:['M4 6V4h16v2','M12 4v16','M9 20h6'],
    align:['M4 4h16','M4 12h10','M4 20h14'],
    distribute:['M4 4h2v16H4z','M18 4h2v16h-2z','M9 8h6v8H9z'],
    resize:['M4 9V4h5','M20 15v5h-5','M4 4l6 6','M20 20l-6-6'],
    refresh:['M20 11a8 8 0 1 0-2.3 5.7','M20 4v7h-7'],
    download:['M12 4v12','M7 11l5 5 5-5','M4 20h16'],
    back:['M10 6l-6 6 6 6','M4 12h16'],
    slide:['M4 4h16v12H4z','M9 20h6','M12 16v4'],
    chevron:['M9 6l6 6-6 6'],
    folder:['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    'arrow-up':['M12 20V4','M5 11l7-7 7 7'],
  }
  const icon=(name,size=16,extra={})=>h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':'true',style:{flex:'none'},...extra},...(iconPaths[name]||[]).map((d,i)=>h('path',{key:i,d})))
  const Spinner=({size='sm'})=>h('span',{className:'spinner'+(size==='sm'?' sm':size==='md'?' md':''),'aria-hidden':'true'})
  const api=async(action,body={})=>{const r=await fetch('/api/ppt-ultra.'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let data;try{data=await r.json()}catch{throw new Error('接口返回异常（HTTP '+r.status+'）')};if(!data.ok)throw new Error(data.error||'操作失败');return data.value}
  const fileBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('读取文件失败'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file)})

  function SlideImage({src,alt,onRetry}){
    const [status,setStatus]=React.useState('loading'),[nonce,setNonce]=React.useState(0)
    React.useEffect(()=>{setStatus('loading')},[src])
    const retry=()=>{setNonce(n=>n+1);setStatus('loading');onRetry&&onRetry()}
    return h('div',{className:'slide-img'},
      status!=='ready'&&h('div',{className:'img-state'},
        status==='loading'?h(React.Fragment,null,h(Spinner,{size:'md'}),h('span',{className:'state-title'},'正在加载预览…'),h('span',{className:'state-sub'},alt))
          :h(React.Fragment,null,h('div',{className:'icon-wrap'},icon('image',20)),h('span',{className:'state-title'},'预览加载失败'),h('span',{className:'state-sub'},'图片未能显示，可重试或重新打开文稿。'),h('button',{type:'button',className:'soft',onClick:retry},icon('refresh',14),'重试')),
      ),
      src&&h('img',{key:nonce,src,alt,className:status==='ready'?'show':'',onLoad:()=>setStatus('ready'),onError:()=>setStatus('error')}))
  }
  function Thumb({src,page,active,affected,onClick}){
    const [state,setState]=React.useState('loading')
    React.useEffect(()=>{setState('loading')},[src])
    return h('button',{type:'button',className:'thumb'+(active?' active':''),'aria-label':`第 ${page} 页`,onClick},
      h('span',{className:'thumb-card'},
        h('span',{className:'thumb-media'},
          src?h('img',{src,alt:'',loading:'lazy',className:state==='ready'?'show':'',onLoad:()=>setState('ready'),onError:()=>setState('error')}):null,
          state!=='ready'&&h('span',{className:'thumb-state'},state==='error'?icon('image',16):h(Spinner))),
      ),
      h('span',{className:'thumb-meta'},h('span',{className:'thumb-no'},String(page).padStart(2,'0')),affected?h('span',{className:'thumb-badge'},'本轮'):null))
  }

  const fmtSize=bytes=>{if(typeof bytes!=='number'||!isFinite(bytes))return '';if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return (bytes/1024).toFixed(bytes<10240?1:0)+' KB';return (bytes/1024/1024).toFixed(1)+' MB'}

  /** 文件选择：仓库下拉 + 目录浏览（Host 侧 browse 路由只返回目录和 .pptx）。 */
  function FilePanel({hidden,sessionId,state,sessionCwd,busy,selectedSpaceId,onSelectSpace,onOpen,onError,startNewConversation,onToggleStartNew}){
    const [spaces,setSpaces]=React.useState([]),[spaceError,setSpaceError]=React.useState(''),[dir,setDir]=React.useState(''),[entries,setEntries]=React.useState([]),[loading,setLoading]=React.useState(false),[error,setError]=React.useState('')
    const space=spaces.find(item=>item.id===selectedSpaceId)
    const load=React.useCallback(async target=>{
      if(!space)return
      setLoading(true);setError('')
      try{const value=await api('browse',{root:space.path,dir:target||space.path});setDir(value.dir||space.path);setEntries(value.entries||[])}
      catch(e){setError(e.message);setEntries([])}
      finally{setLoading(false)}
    },[space&&space.id,space&&space.path])
    React.useEffect(()=>{
      let live=true
      api('workspaces').then(value=>{
        if(!live)return
        const items=value&&value.items||[]
        setSpaces(items)
        if(!items.length)return
        if(!items.some(item=>item.id===selectedSpaceId)){
          const sourcePath=state&&state.sourcePath||'',cwd=sessionCwd||'',probe=sourcePath||cwd
          const hit=items.find(item=>probe&&(probe===item.path||probe.startsWith(item.path+'/')))
          onSelectSpace((hit||items[0]).id)
        }
      }).catch(e=>{if(live)setSpaceError(e.message)})
      return()=>{live=false}
    },[state&&state.sourcePath,sessionCwd])
    React.useEffect(()=>{if(space)void load(space.path)},[space&&space.id])
    const relative=space&&dir&&dir!==space.path?dir.slice(space.path.length).split('/').filter(Boolean):[]
    const go=path=>{if(busy)return;void load(path)}
    return h('div',{className:'panel-pane file-pane',style:hidden?{display:'none'}:undefined},
      h('div',{className:'file-bar'},
        h('select',{'aria-label':'选择仓库',value:selectedSpaceId||'',disabled:!spaces.length||loading,onChange:e=>onSelectSpace(e.target.value)},spaces.map(item=>h('option',{key:item.id,value:item.id},item.title||item.path))),
        h('button',{type:'button',className:'icon-btn',title:'刷新目录',disabled:loading||!space,onClick:()=>go(dir||space.path)},icon('refresh',15))),
      spaceError?h('div',{className:'warn-card'},h('strong',null,'无法读取仓库列表'),h('span',null,spaceError)):null,
      !spaces.length&&!spaceError?h('div',{className:'file-note'},h(Spinner,{size:'sm'}),'正在读取仓库…'):null,
      error?h('div',{className:'warn-card'},h('strong',null,'无法读取目录'),h('span',null,error)):null,
      space?h('div',{className:'crumbs'},
        h('button',{type:'button',onClick:()=>go(space.path)},space.title),
        ...relative.map((part,index)=>h(React.Fragment,{key:index},h('span',{className:'sep'},'/'),h('button',{type:'button',onClick:()=>go(space.path+relative.slice(0,index+1).map(p=>'/'+p).join(''))},part)))):null,
      space?(entries.length?h('div',{className:'files'},entries.map(entry=>h('button',{key:entry.path,type:'button',title:entry.path,disabled:loading||busy,className:'file-row'+(state&&state.sourcePath===entry.path?' current':''),onClick:()=>entry.type==='dir'?go(entry.path):onOpen(entry.path,entry.name,startNewConversation)},
        icon(entry.type==='dir'?'folder':'file',14),
        h('span',{className:'name'},entry.name),
        h('span',{className:'meta'},entry.type==='dir'?'目录':(state&&state.sourcePath===entry.path?'当前':fmtSize(entry.size))))))
        :h('div',{className:'file-note'},loading?'正在读取目录…':'该目录下没有子目录或 .pptx 文件。')):null,
      h('div',{className:'file-foot'},
        h('label',{className:'file-option',title:'新建对话拥有独立上下文'},h('input',{type:'checkbox',checked:!!startNewConversation,onChange:e=>onToggleStartNew(e.target.checked)}),'打开时新建对话（独立上下文）'),
        h('p',{className:'section-hint',style:{margin:0}},'只显示目录和 .pptx 文件；打开后切到「对话」描述修改。')))
  }

  /** 对话：轮询当前 Session 的消息，发送指令给 Agent，并在上方展示待应用修改。 */
  function ChatPanel({hidden,sessionId,sessionTitle,sessionReady,state,docContext,busy,sendInstruction,cancelGeneration,onNewConversation,onLocate,onApply,onCancelProposal,onUndo,objectName}){
    const [messages,setMessages]=React.useState([]),[stream,setStream]=React.useState(''),[running,setRunning]=React.useState(false),[available,setAvailable]=React.useState(true),[conversationError,setConversationError]=React.useState(''),[draft,setDraft]=React.useState(''),[sending,setSending]=React.useState(false),[confirmed,setConfirmed]=React.useState(false),[creating,setCreating]=React.useState(false)
    const fast=React.useRef(false),sendingRef=React.useRef(false),logRef=React.useRef(null),nearBottom=React.useRef(true),liveRef=React.useRef(true)
    React.useEffect(()=>{
      if(!sessionId){setMessages([]);setStream('');setRunning(false);return}
      liveRef.current=true
      let timer
      const tick=async()=>{
        try{
          const value=await api('conversation',{sessionId})
          if(!liveRef.current)return
          setMessages(value&&value.messages||[]);setStream(value&&value.stream||'');setRunning(!!(value&&value.running));setAvailable(!(value&&value.available===false));setConversationError('')
        }catch(e){if(liveRef.current)setConversationError(e.message)}
        finally{if(liveRef.current)timer=setTimeout(tick,fast.current?500:1200)}
      }
      void tick()
      return()=>{liveRef.current=false;clearTimeout(timer)}
    },[sessionId])
    React.useEffect(()=>{if(logRef.current&&nearBottom.current)logRef.current.scrollTop=logRef.current.scrollHeight},[messages,stream,state&&state.proposal&&state.proposal.id])
    React.useEffect(()=>{setConfirmed(false)},[state&&state.proposal&&state.proposal.id])
    const waiting=sending||running
    const canSend=!!state&&!!sessionReady&&!!sendInstruction&&!busy
    const buildPrompt=text=>{
      if(!docContext)return text
      const selected=docContext.selected&&docContext.selected.length?`已选对象：${JSON.stringify(docContext.selected)}。`:''
      return `请使用 PPT Ultra 受限工具处理下面指令。先用 ppt_ultra_read 读取文稿 ${docContext.id}，确认 revision ${docContext.revision} 和对象 fingerprint。当前焦点页：第 ${docContext.page} 页（ID ${docContext.pageId}）。${selected}用户指令：${text}\n请调用 ppt_ultra_propose 生成完整修订清单，保留用户尚未取消的已有操作。目标不明确时调用 ppt_ultra_clarify 显示问题和候选对象，不要猜测；不要调用 shell 修改文件，不要应用或导出，等待用户在「对话」面板中确认应用。`
    }
    const send=async()=>{
      if(sendingRef.current||!draft.trim()||!canSend)return
      sendingRef.current=true;setSending(true);setConversationError('');fast.current=true
      const text=draft
      try{
        await sendInstruction(buildPrompt(text))
        setDraft('');nearBottom.current=true
        try{const value=await api('conversation',{sessionId});setMessages(value&&value.messages||[]);setStream(value&&value.stream||'');setRunning(!!(value&&value.running))}catch(_error){}
      }catch(e){setConversationError(e.message)}
      finally{sendingRef.current=false;setSending(false);setTimeout(()=>{fast.current=false},60000)}
    }
    const stop=async()=>{if(!cancelGeneration)return;try{await cancelGeneration()}catch(e){setConversationError(e.message)}}
    const newConversation=async()=>{if(creating||busy)return;setCreating(true);setConversationError('');try{await onNewConversation()}catch(e){setConversationError(e.message)}finally{setCreating(false)}}
    const userText=text=>{const match=typeof text==='string'?text.match(/用户指令：([\s\S]*?)(?:\n|$)/):null;return match?match[1]:text}
    const proposal=state&&state.proposal,clarification=state&&state.clarification,history=state&&state.history||[]
    return h('div',{className:'panel-pane chat-pane',style:hidden?{display:'none'}:undefined},
      h('div',{className:'chat-head'},
        h('div',{className:'who'},h('strong',null,sessionTitle||'新对话'),sessionId?(sessionReady?'当前对话':'正在连接…'):'还没有对话'),
        h('button',{type:'button',disabled:creating||busy,title:'新建对话拥有独立上下文',onClick:newConversation},icon('plus',13),creating?'新建中…':'新建对话')),
      h('p',{className:'chat-hint'},'每个对话的上下文相互独立。先在「文件选择」打开文稿，再用一句话描述要改什么。'),
      sessionId&&!available?h('p',{className:'chat-hint'},'对话记录暂不可用；发送消息后会恢复。'):null,
      h('div',{className:'chat-log',ref:logRef,onScroll:()=>{const el=logRef.current;if(el)nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80}},
        messages.length?messages.map((message,index)=>{
          const role=message.role==='user'?'user':'assistant'
          return h('div',{key:message.id||index,className:'msg '+role},
            h('span',{className:'who'},role==='user'?'我':'助手'),
            h('div',{className:'body'},role==='user'?userText(message.text):message.text))
        }):(waiting?null:h('div',{className:'chat-empty'},state?'还没有消息。在下面描述要改什么，Agent 会读取文稿并提出可预览的修改。':'先在「文件选择」里打开一份 PPTX，再通过对话修改。')),
        stream?h('div',{className:'msg assistant'},h('span',{className:'who'},'助手'),h('div',{className:'body'},stream)):null,
        waiting?h('div',{className:'typing'},h(Spinner,{size:'sm'}),'正在处理…'):null),
      clarification?h('div',{className:'warn-card chat-clarify'},h('strong',null,clarification.question),...(clarification.candidates||[]).map(id=>h('button',{key:id,type:'button',onClick:()=>onLocate(id)},objectName(id)))):null,
      proposal?h('div',{className:'proposal-card'},
        h('strong',null,`待应用修改 · ${proposal.operations.length} 条`),
        h('span',{className:'sub'},`影响 ${proposal.affected&&proposal.affected.length||0} 页；请先核对中间「修改后」预览。`),
        proposal.checks&&proposal.checks.length?h('div',{className:'checks'},proposal.checks.map((check,index)=>h('span',{key:index,className:'check-line '+(check.level||'')},(check.level==='error'?'需要处理：':check.level==='warning'?'提醒：':check.level==='review'?'待确认：':'通过：')+check.message))):null,
        h('label',{className:'confirm'},h('input',{type:'checkbox',checked:confirmed,disabled:!!busy||!proposal.ready,onChange:e=>setConfirmed(e.target.checked)}),'已核对「修改后」预览、溢出与裁切，并知悉字体提醒'),
        h('div',{className:'actions'},
          h('button',{type:'button',className:'primary',disabled:!!busy||!confirmed||!proposal.ready,onClick:()=>onApply(proposal.id,confirmed)},icon('check',14),'应用修改'),
          h('button',{type:'button',disabled:!!busy,onClick:onCancelProposal},'取消待应用')))
        :(history.length?h('div',{className:'history-line'},`已应用 ${history.length} 轮修改`,h('button',{type:'button',disabled:!!busy,onClick:onUndo},icon('undo',13),'撤销最近一轮')):null),
      h('div',{className:'chat-composer'},
        h('div',{className:'row'},
          h('textarea',{'aria-label':'对话指令',placeholder:state?'例如：标题短一点，右边两张图顶端对齐':'先打开一份 PPTX 再开始',value:draft,disabled:!canSend,onChange:e=>setDraft(e.target.value),onKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent?.isComposing&&!e.isComposing&&e.keyCode!==229){e.preventDefault();void send()}}}),
          waiting?h('button',{type:'button',className:'send-btn stop','aria-label':'停止','title':'停止生成',onClick:()=>void stop()},h(Spinner,{size:'sm'})):h('button',{type:'button',className:'send-btn','aria-label':'发送','title':'发送',disabled:!canSend||!draft.trim(),onClick:()=>void send()},icon('arrow-up',16))),
        h('p',{className:'section-hint',style:{margin:0}},'Enter 发送，Shift+Enter 换行；修改会先预览，需要你确认后应用。'))
    )
  }

  function Workbench({sessionId,sessionTitle,sessionReady,sessionCwd,onExit,sendInstruction,cancelGeneration,onNewConversation}){
    const [state,setState]=React.useState(null),[docs,setDocs]=React.useState([]),[page,setPage]=React.useState(0),[selection,setSelection]=React.useState([]),[busy,setBusy]=React.useState(''),[error,setError]=React.useState(''),[tab,setTab]=React.useState('files'),[zoom,setZoom]=React.useState(1),[mode,setMode]=React.useState(()=>innerWidth<1180?'after':'both'),[marks,setMarks]=React.useState(true),[panel,setPanel]=React.useState(()=>innerWidth>=1180),[canvasWidth,setCanvasWidth]=React.useState(700),[upload,setUpload]=React.useState(null),[elapsed,setElapsed]=React.useState(0),[spaceId,setSpaceId]=React.useState(''),[newOnOpen,setNewOnOpen]=React.useState(false)
    const viewport=React.useRef(null),rootRef=React.useRef(null),stateRef=React.useRef(null),busyRef=React.useRef(false),pendingReopen=React.useRef(undefined),previousSession=React.useRef(sessionId),previousDoc=React.useRef(undefined),spaceIdRef=React.useRef('')
    React.useEffect(()=>{spaceIdRef.current=spaceId},[spaceId])
    const receive=React.useCallback(value=>{stateRef.current=value;setState(value)},[])
    const run=async(label,fn)=>{if(busyRef.current)return;busyRef.current=true;setBusy(label);setError('');try{return await fn()}catch(e){setError(e.message)}finally{busyRef.current=false;setBusy('')}}
    React.useEffect(()=>{
      if(!sessionId)return
      let live=true
      const poll=async()=>{
        if(busyRef.current)return
        try{
          const items=await api('list',{sessionId})
          if(!live)return
          setDocs(items);rememberDocs(sessionId,items)
          const id=stateRef.current&&stateRef.current.id||items.slice().sort((a,b)=>b.updatedAt-a.updatedAt)[0]&&items.slice().sort((a,b)=>b.updatedAt-a.updatedAt)[0].id
          if(id){const value=await api('state',{id,sessionId});if(live&&!busyRef.current&&(value.updatedAt!==(stateRef.current&&stateRef.current.updatedAt)||value.id!==(stateRef.current&&stateRef.current.id)))receive(value)}
        }catch(e){if(live)setError(e.message)}
      }
      void poll()
      const timer=setInterval(poll,2500)
      return()=>{live=false;clearInterval(timer)}
    },[sessionId,receive])
    React.useEffect(()=>{
      if(previousSession.current===sessionId)return
      previousSession.current=sessionId
      if(stateRef.current&&stateRef.current.sessionId!==sessionId){stateRef.current=null;setState(null);setDocs([]);setPage(0);setSelection([]);setTab('files')}
      const path=pendingReopen.current;pendingReopen.current=undefined
      if(path&&sessionId){void run('正在新对话中打开文稿…',async()=>{const value=await api('openPath',{sessionId,path});receive(value);setPage(0);setSelection([]);setTab('chat')})}
    },[sessionId])
    React.useEffect(()=>{
      if(state&&state.id&&previousDoc.current!==state.id){previousDoc.current=state.id;setTab('chat');setPage(0)}
    },[state&&state.id])
    React.useEffect(()=>{if(!upload)return;const start=upload.startedAt;const tick=()=>setElapsed(Math.max(0,Math.round((Date.now()-start)/1000)));tick();const timer=setInterval(tick,500);return()=>clearInterval(timer)},[upload])
    React.useEffect(()=>{if(!viewport.current)return;const observer=new ResizeObserver(([entry])=>setCanvasWidth(Math.max(240,entry.contentRect.width-48)));observer.observe(viewport.current);return()=>observer.disconnect()},[!!state])
    React.useEffect(()=>{
      const el=rootRef.current
      if(!el)return
      const observer=new ResizeObserver(([entry])=>{const narrow=entry.contentRect.width<980;setPanel(!narrow);if(narrow)setMode(current=>current==='both'?'after':current)})
      observer.observe(el)
      return()=>observer.disconnect()
    },[])
    const data=state&&state.current.document,slide=data&&data.slides[Math.min(page,(data.slides.length||1)-1)],objects=slide&&slide.objects||[]
    const kindText=o=>o.kind==='pic'?'图片':o.kind==='grpSp'?'组合':o.kind==='graphicFrame'?'图表':o.kind==='cxnSp'?'连线':o.textEditable?'文本':'形状'
    const objLabel=(o,idx)=>{if(o.name)return o.name;if(o.textEditable&&o.text){const text=o.text.replace(/\s+/g,' ').trim();if(text)return text.length>26?text.slice(0,26)+'…':text}return kindText(o)+' '+(idx+1)}
    const labels=new Map();data&&data.slides.forEach(s=>s.objects.forEach((o,i)=>labels.set(o.id,objLabel(o,i))))
    const names=ids=>ids.map(id=>labels.get(id)||id).join('、')
    const targets=(state&&state.proposal&&state.proposal.operations||[]).flatMap(o=>o.targets)
    const base=()=>({id:state.id,sessionId,revision:state.revision})
    const selectPage=index=>{setPage(index);setSelection([])}
    const toggle=id=>setSelection(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id])
    const uploadFile=file=>{
      if(!file)return
      if(!sessionId){setError('请先在「文件选择」里选择文稿，或新建对话。');return}
      if(file.size>50*1024*1024){setError('文件须小于 50 MiB');return}
      if(!/\.pptx$/i.test(file.name)){setError('首版仅支持 .pptx 文件');return}
      setUpload({name:file.name,startedAt:Date.now()});setElapsed(0)
      run('正在读取并渲染文稿…',async()=>{const value=await api('open',{sessionId,name:file.name,base64:await fileBase64(file)});receive(value);setPage(0);setSelection([]);setTab('chat')}).finally(()=>setUpload(null))
    }
    const openFromPicker=async(path,name,startNew)=>{
      if(busyRef.current)return
      if(startNew||!sessionId){pendingReopen.current=path;try{await onNewConversation(spaceIdRef.current||undefined);setNewOnOpen(false)}catch(e){pendingReopen.current=undefined;setError(e.message)}return}
      await run(`正在打开 ${name||'文稿'}…`,async()=>{const value=await api('openPath',{sessionId,path});receive(value);setPage(0);setSelection([]);setTab('chat')})
    }
    const newConversation=async()=>{
      const path=stateRef.current&&stateRef.current.sourcePath
      pendingReopen.current=path||undefined
      try{await onNewConversation(spaceIdRef.current||undefined)}catch(e){pendingReopen.current=undefined;throw e}
    }
    const locate=objectId=>{
      const slides=data&&data.slides||[]
      for(let index=0;index<slides.length;index++){if(slides[index].objects.some(o=>o.id===objectId)){setPage(index);setSelection([objectId]);return}}
    }
    const download=(name,blob)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)}
    const exportFile=()=>run('正在导出…',async()=>{const result=await api('export',base());download(result.name,new Blob([Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}));download(result.name.replace(/\.pptx$/, '-变更清单.json'),new Blob([JSON.stringify(result.changes,null,2)],{type:'application/json'}))})
    const applyProposal=(proposalId,visualConfirmed)=>run('正在复核并应用整批修改…',async()=>{receive(await api('apply',{...base(),proposalId,visualConfirmed}))})
    const cancelProposal=()=>run('正在取消…',async()=>receive(await api('cancel',base())))
    const undoRound=()=>run('正在恢复上一份草稿…',async()=>receive(await api('undo',base())))
    const button=(label,fn,extra={})=>h('button',{type:'button',onClick:fn,disabled:!!busy,...extra},label)
    const notice=busy
      ?h('span',{className:'status chip live',role:'status'},h(Spinner,{size:'sm'}),busy)
      :state&&state.proposal?h('span',{className:'chip live'},'有待应用修改')
      :state&&state.exportable?h('span',{className:'chip ok'},'可导出')
      :state?h('span',{className:'chip'},'在右侧对话中描述修改'):null
    const canExport=!!(state&&state.exportable&&!busy)
    const exportHint=!state?'尚未打开文稿':busy?'正在处理，请稍候':!state.exportable?'先应用修改，通过检查后才能导出':'导出 PPTX 与变更清单'
    const docContext=state?{name:state.name,id:state.id,revision:state.revision,page:slide.page,pageId:slide.id,selected:selection}:null
    const frame=which=>{
      const snap=which==='before'?state.before:state.after,img=snap.rendered.images.find(i=>i.page===slide.page),s=snap.document.slides.find(x=>x.id===slide.id),w=Math.round(canvasWidth*zoom),height=w*data.size.height/data.size.width
      const label=which==='before'?'修改前':'修改后',status=which==='after'?(state.proposal?'待应用预览':'当前草稿'):'本轮基准'
      const renderedError=state.current.rendered.ok===false?state.current.rendered.error:''
      return h('div',{key:which,className:'frame '+which,style:{width:w}},
        h('div',{className:'frame-head'},h('span',{className:'frame-title'},h('span',{className:'mark'}),label),h('span',{className:'frame-chip'+(which==='after'&&state.proposal?' accent':'')},status)),
        h('div',{className:'slide',style:{width:w,height}},
          img?h(SlideImage,{src:img.url,alt:`第 ${slide.page} 页${label}`}):h('div',{className:'render-missing'},h('div',{className:'icon-wrap'},icon('image',20)),h('strong',null,'视觉检查未完成'),h('span',{className:'state-sub'},renderedError||'该页预览图缺失，可重新打开文稿或更新预览。')),
          which==='after'&&img&&(s&&s.objects||[]).filter(o=>o.geometry&&o.editable).map(o=>h('button',{key:o.id,type:'button',title:o.name,'aria-label':`选择 ${o.name}`,'aria-pressed':selection.includes(o.id),className:'hit'+(selection.includes(o.id)?' selected':'')+(marks&&targets.includes(o.id)?' changed':''),style:{left:o.geometry.x/data.size.width*100+'%',top:o.geometry.y/data.size.height*100+'%',width:o.geometry.width/data.size.width*100+'%',height:o.geometry.height/data.size.height*100+'%'},onClick:()=>toggle(o.id)}))))
    }
    const welcome=h('div',{className:'welcome'},h('div',{className:'welcome-inner'},
      h('span',{className:'eyebrow'},'保留原稿 · 精准微调 · 可继续编辑'),
      h('h1',{className:'welcome-title'},'让每一处修改，都看得见'),
      h('p',{className:'welcome-sub'},'在右侧「文件选择」里选仓库和 PPTX；打开后直接对话描述要改什么，预览确认后再应用。'),
      upload?h('div',{className:'loading-box',role:'status','aria-live':'polite'},h(Spinner),h('strong',null,'文件正在加载'),h('span',{className:'loading-file'},upload.name),h('span',{className:'loading-phase'},busy||'正在解析文稿…'),h('span',{className:'loading-hint'},`已用时 ${elapsed} 秒 · 首次打开需要渲染每一页，通常需要十几秒`))
        :!sessionId?h('div',{className:'warn-card welcome-warn'},h('strong',null,'还没有对话'),h('span',null,'在右侧「文件选择」选择仓库和文稿会自动新建对话；也可以先在「对话」里点「新建对话」。'))
        :h('div',{className:'welcome-actions'},
            h('button',{type:'button',className:'primary',onClick:()=>setTab('files')},icon('folder',15),'选择仓库和文件'),
            h('label',{className:'dropzone-mini'},icon('plus',14),'从本地选择 .pptx',h('input',{type:'file',accept:'.pptx',disabled:!!busy,onChange:e=>uploadFile(e.target.files[0])}))),
      h('div',{className:'welcome-foot'},'首版支持 .pptx；对话里可以让 Agent 缩标题、改文字、换图、对齐、等距和改尺寸。')))
    const side=h('aside',{className:'side'+(!panel?' collapsed':'')},
      h('div',{className:'tabs'},...[['files','文件选择'],['chat','对话']].map(([value,title])=>h('button',{key:value,type:'button',className:'tab'+(tab===value?' active':''),onClick:()=>setTab(value)},title,
        value==='chat'&&state&&state.proposal?h('span',{className:'tab-badge'},state.proposal.operations.length):null))),
      h('div',{className:'panel-body'},
        h(FilePanel,{hidden:tab!=='files',sessionId,state,sessionCwd,busy,selectedSpaceId:spaceId,onSelectSpace:setSpaceId,onOpen:openFromPicker,onError:setError,startNewConversation:newOnOpen,onToggleStartNew:setNewOnOpen}),
        h(ChatPanel,{hidden:tab!=='chat',sessionId,sessionTitle,sessionReady,state,docContext,busy,sendInstruction,cancelGeneration,onNewConversation:newConversation,onLocate:locate,onApply:applyProposal,onCancelProposal:cancelProposal,onUndo:undoRound,objectName:id=>labels.get(id)||id})))
    const center=state?h('section',{className:'center'},
      h('div',{className:'toolbar'},
        h('div',{className:'page-indicator'},h('strong',null,`第 ${slide.page} 页`),h('span',null,`/ ${data.slides.length} 页`)),
        h('div',{className:'toolbar-spacer'}),
        h('div',{className:'seg',role:'group','aria-label':'对照模式'},...Object.entries({both:'上下对照',before:'修改前',after:'修改后'}).map(([value,title])=>button(title,()=>setMode(value),{key:value,className:mode===value?'active':''}))),
        h('div',{className:'zoom'},h('button',{type:'button',onClick:()=>setZoom(Math.max(.25,zoom-.25)),'aria-label':'缩小'},'−'),h('span',{className:'zoom-val'},Math.round(zoom*100)+'%'),h('button',{type:'button',onClick:()=>setZoom(Math.min(3,zoom+.25)),'aria-label':'放大'},'＋')),
        h('label',{className:'marks'},h('input',{type:'checkbox',checked:marks,onChange:e=>setMarks(e.target.checked)}),'标注')),
      h('div',{className:'canvas-scroll',ref:viewport},h('div',{className:'comparison'},...(mode==='both'?['before','after']:[mode]).map(frame)))):welcome
    const layout=h('main',{className:'layout'+(state?'':' no-doc')},
      state?h('nav',{className:'pages','aria-label':'页面导航'},
        h('div',{className:'pages-head'},h('div',null,h('strong',null,'幻灯片'),h('span',{className:'count'},`${data.slides.length} 页`)),h('label',{className:'icon-btn',title:'打开另一份 PPTX',style:{cursor:'pointer'}},icon('plus',16),h('input',{type:'file',accept:'.pptx',disabled:!!busy,style:{display:'none'},onChange:e=>uploadFile(e.target.files[0])}))),
        docs.length>1?h('select',{'aria-label':'切换文稿',className:'doc-switch',value:state.id,disabled:!!busy,onChange:e=>run('正在打开…',async()=>{receive(await api('state',{id:e.target.value,sessionId}));selectPage(0)})},docs.map(d=>h('option',{key:d.id,value:d.id},d.name))):null,
        h('div',{className:'thumbs'},...data.slides.map((s,i)=>h(Thumb,{key:s.id,page:i+1,src:state.current.rendered.images.find(x=>x.page===s.page)?.url,active:i===page,affected:!!(state.proposal&&state.proposal.affected&&state.proposal.affected.includes(s.id)),onClick:()=>selectPage(i)})))):null,
      center,
      side)
    return h('div',{className:'pu',ref:rootRef,role:'main','aria-label':'PPT Ultra 工作台'},h('style',null,css),
      h('header',{className:'top'},
        h('div',{className:'brand-row'},h('div',{className:'logo'},icon('file',17)),h('div',{className:'brand-text'},'PPT',h('span',null,'Ultra'))),
        h('div',{className:'top-divider'}),
        h('div',{className:'top-doc'},state&&icon('file',14),h('span',{className:'filename'+(state?'':' placeholder')},state&&state.name||'演示文稿微调工作台')),
        h('div',{className:'top-status'},notice),
        h('div',{className:'top-actions'},
          button(h(React.Fragment,null,icon('panel',14),'面板'),()=>setPanel(!panel),{className:'narrow-only ghost'}),
          button(h(React.Fragment,null,icon('download',15),'导出 PPTX'),exportFile,{className:canExport?'primary':'ghost',disabled:!canExport,title:exportHint,'aria-label':'导出 PPTX'}),
          h('span',{className:'sep','aria-hidden':'true'}),
          button(h(React.Fragment,null,icon('back',15),h('span',{className:'exit-label'},'退出 PPT')),onExit,{className:'ghost exit-btn',title:'退出 PPT 并返回对话，文稿与修改会保留','aria-label':'退出 PPT'}))),
      h('div',{className:'busybar'+(busy?' on':''),'aria-hidden':'true'}),
      error?h('div',{className:'error',role:'alert'},icon('alert',15),h('span',{className:'grow'},error),h('button',{type:'button',className:'icon-btn','aria-label':'关闭提示',onClick:()=>setError('')},icon('close',14))):null,
      layout)
  }

  /** 侧栏/主区域面板标识，与 cordis 侧栏行、main 面板 key 一致。 */
  const PANEL_ID='ppt-ultra'
  const CHAT_SESSION_KEY='dsh.ppt-ultra.chat-session'
  const sendToSession=(ctx,sessionId)=>async text=>{const binding=ctx.sessions.binding(sessionId);if(!binding)throw new Error('对话尚未就绪');const result=await binding.session.prompt([{type:'text',text}],'queue');if(result&&result.ok===false)throw new Error(result.error?.message||'指令提交失败')}
  const cancelSession=(ctx,sessionId)=>async()=>{const binding=ctx.sessions.binding(sessionId);if(!binding)throw new Error('对话尚未就绪');const result=await binding.session.cancel();if(result&&result.ok===false)throw new Error(result.error?.message||'停止失败')}
  /** 取当前主视图绑定的会话；页面级入口没有 sessionId prop，用 retainedBy.mainView 反查。 */
  const currentSessionId=ctx=>{
    try{
      const byId=ctx.sessions.list.getSnapshot()?.byId||{}
      for(const id of Object.keys(byId)){const row=byId[id];if(row&&(row.retainedBy?.mainView??0)>0)return row.id||id}
    }catch{}
    return undefined
  }
  function useCurrentSessionId(ctx){
    const [sessionId,setSessionId]=React.useState(()=>currentSessionId(ctx))
    React.useEffect(()=>{
      const update=()=>setSessionId(currentSessionId(ctx))
      update()
      const dispose=ctx.sessions.list.subscribe(update)
      return typeof dispose==='function'?dispose:()=>{}
    },[ctx])
    return sessionId
  }
  const activePanelId=ctx=>{try{return ctx.layout.panelInfo.getSnapshot().activePanelId}catch{return undefined}}
  function usePanelActive(ctx,id){
    const [active,setActive]=React.useState(()=>activePanelId(ctx)===id)
    React.useEffect(()=>{
      const update=()=>setActive(activePanelId(ctx)===id)
      update()
      const dispose=ctx.layout.panelInfo.subscribe(update)
      return typeof dispose==='function'?dispose:()=>{}
    },[ctx,id])
    return active
  }
  /** 每个会话最近一次可见的文稿 ID 集合；工作台/监听器共同更新，避免重复自动进入。 */
  const knownDocs=new Map()
  const rememberDocs=(sessionId,items)=>{if(sessionId)knownDocs.set(sessionId,new Set((items||[]).map(item=>item.id)))}
  /**
   * 在工作台未打开时轻量轮询当前会话的文稿列表：Agent 用 ppt_ultra_open 打开新文稿后自动切到工作台。
   * 首次拉取只建立基线，不会把历史文稿当成新文稿。
   */
  function EntryWatcher({ctx}){
    const sessionId=useCurrentSessionId(ctx),active=usePanelActive(ctx,PANEL_ID)
    React.useEffect(()=>{
      if(!sessionId||active)return
      let live=true,timer
      const tick=async()=>{
        if(!live)return
        try{
          const items=await api('list',{sessionId})
          if(!live)return
          const ids=new Set(items.map(item=>item.id))
          const previous=knownDocs.get(sessionId)
          knownDocs.set(sessionId,ids)
          if(!previous)return
          if([...ids].some(id=>!previous.has(id))){
            const panel=activePanelId(ctx)
            if(panel===null||panel===undefined)ctx.layout.selectPanel(PANEL_ID)
          }
        }catch{}
      }
      void tick();timer=setInterval(tick,3000)
      return ()=>{live=false;clearInterval(timer)}
    },[sessionId,active,ctx])
    return null
  }
  function PptPanelIcon({size=16}){
    return icon('slide',size)
  }
  const sessionOf=(ctx,id)=>{try{return id?ctx.sessions.list.getSnapshot()?.byId?.[id]:undefined}catch{return undefined}}
  /** 页面级工作台：左侧栏入口进入；对话绑定一个 DSH Session，「新建对话」创建新的 Session。 */
  function WorkbenchPage({ctx}){
    const currentId=useCurrentSessionId(ctx)
    const [sessionId,setSessionId]=React.useState(()=>{try{const saved=localStorage.getItem(CHAT_SESSION_KEY);if(saved&&sessionOf(ctx,saved))return saved}catch{};return undefined})
    const [ready,setReady]=React.useState(false)
    const [,forceMeta]=React.useReducer(value=>value+1,0)
    React.useEffect(()=>{
      let dispose
      try{const listener=ctx.sessions.list.subscribe(forceMeta);if(typeof listener==='function')dispose=listener}catch{}
      return()=>{try{dispose&&dispose()}catch{}}
    },[ctx])
    React.useEffect(()=>{if(!sessionId&&currentId)setSessionId(currentId)},[sessionId,currentId])
    React.useEffect(()=>{
      if(!sessionId){setReady(false);return}
      setReady(false)
      let reference
      try{reference=ctx.sessions.retain(sessionId,{source:'ppt-ultra'})}catch(e){setReady(false);return}
      let cancelled=false
      reference.ready.then(()=>{if(cancelled){try{reference.release()}catch{};return}setReady(true)},()=>{setReady(false);try{reference.release()}catch{}})
      return()=>{cancelled=true;try{reference.release()}catch{}}
    },[ctx,sessionId])
    const session=sessionOf(ctx,sessionId)
    const sessionTitle=session&&session.title||''
    const sessionCwd=session&&session.cwd||''
    const chooseSession=React.useCallback(id=>{try{if(id)localStorage.setItem(CHAT_SESSION_KEY,id);else localStorage.removeItem(CHAT_SESSION_KEY)}catch{};setSessionId(id)},[])
    const createConversation=React.useCallback(async workspaceId=>{
      const options=workspaceId?{workspaceId}:(sessionCwd?{cwd:sessionCwd}:{})
      const id=await ctx.sessions.create(options)
      chooseSession(id)
      return id
    },[ctx,sessionCwd,chooseSession])
    const sendInstruction=React.useMemo(()=>sessionId&&ready?sendToSession(ctx,sessionId):undefined,[ctx,sessionId,ready])
    const cancelGeneration=React.useMemo(()=>sessionId&&ready?cancelSession(ctx,sessionId):undefined,[ctx,sessionId,ready])
    return h(Workbench,{sessionId,sessionTitle,sessionReady:ready,sessionCwd,onExit:()=>ctx.layout.selectPanel(null),sendInstruction,cancelGeneration,onNewConversation:createConversation})
  }
  function apply(ctx){
    ctx.effect(()=>ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL_ID,inject:()=>({ctx})},WorkbenchPage)),'ppt-ultra: workbench page')
    ctx.effect(()=>ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:10,label:()=> 'PPT 工作台'},PptPanelIcon)),'ppt-ultra: sidebar entry')
    ctx.effect(()=>ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'ppt-ultra-doc-watcher',inject:()=>({ctx})},EntryWatcher)),'ppt-ultra: document watcher')
  }
  return {inject:['slots','sessions','layout'],apply,Workbench,WorkbenchPage}
}})
