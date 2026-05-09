import { useState, useEffect, useRef, useCallback } from "react";

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const SHEETJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

const EXTRACT_SYSTEM = `You are a data extraction assistant for Crystal Analytical LLC. Extract only the Sample Information table from this PLM-FRM-010 Bulk Asbestos Chain of Custody form image.

Return ONLY valid JSON — no preamble, no markdown fences, no commentary:
{
  "samples": [
    { "sample_number": "", "ha_code": "", "material_location": "", "material_description": "" }
  ]
}

Rules:
- Sample numbers are sequential integers written by hand (1, 2, 3, 4... or 10, 11, etc.) — NOT 8-digit lab IDs. Extract every row that has a sample number written in the Sample Number column.
- ha_code: the Homogeneous Area code if present (e.g. HA-1, A, 1). Leave empty string if blank.
- material_location rules:
    * If the cell contains actual location text → extract it as-is
    * If the cell contains a carry-forward indicator (an arrow ↓ →, ditto mark ("), hash/tick mark, vertical line |, horizontal dash —, or any symbol clearly meaning "same as above") → return the exact string "<<carry>>"
    * If the cell is completely blank with no marks at all → return empty string ""
- material_description: what the material is (e.g. Drywall, Compound, floor tile, pipe insulation, etc.)
- Empty/illegible fields → empty string
- Only include rows that have a sample number written — skip fully blank rows
- Do not include the header row`;

const COLUMNS = [
  { key: "sample_number",        label: "Sample Number",        width: 130 },
  { key: "ha_code",              label: "HA",                   width: 80  },
  { key: "material_location",    label: "Material Location",    width: 220 },
  { key: "material_description", label: "Material Description", width: 260 },
];

export default function COCExtractor() {
  const [pdfReady, setPdfReady]     = useState(false);
  const [xlsxReady, setXlsxReady]   = useState(false);
  const [files, setFiles]           = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress]     = useState(null);
  const [rows, setRows]             = useState([]);
  const [editCell, setEditCell]     = useState(null);
  const [editVal, setEditVal]       = useState("");
  const [dragOver, setDragOver]     = useState(false);
  const [errors, setErrors]         = useState([]);
  const fileInputRef = useRef(null);
  const editRef      = useRef(null);

  useEffect(() => {
    const loadScript = (src, onLoad) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = onLoad;
      document.head.appendChild(s);
    };
    loadScript(PDFJS_URL, () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      setPdfReady(true);
    });
    loadScript(SHEETJS_URL, () => setXlsxReady(true));
  }, []);

  useEffect(() => {
    if (editRef.current) editRef.current.focus();
  }, [editCell]);

  const renderPageToBase64 = async (pdfDoc, pageNum) => {
    const page     = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.88).split(",")[1];
  };

  const extractPage = async (base64, pageNum, totalPages, filename) => {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: EXTRACT_SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            { type: "text", text: `Page ${pageNum} of ${totalPages} — file: ${filename}. Extract the sample table.` }
          ]
        }]
      })
    });
    const data = await resp.json();
    const txt = data.content?.find(b => b.type === "text")?.text || "{}";
    try {
      return JSON.parse(txt.replace(/```json\n?|```/g, "").trim());
    } catch {
      return { samples: [] };
    }
  };

  const processPdf = async (file) => {
    const buf     = await file.arrayBuffer();
    const pdfDoc  = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const totalPages = pdfDoc.numPages;
    let samples = [];

    for (let p = 1; p <= totalPages; p++) {
      setProgress({ file: file.name, page: p, total: totalPages });
      const b64    = await renderPageToBase64(pdfDoc, p);
      const result = await extractPage(b64, p, totalPages, file.name);
      if (result.samples?.length) samples.push(...result.samples);
    }

    // Carry forward only when AI returned the "<<carry>>" sentinel (explicit indicator on form).
    // Truly blank locations stay blank.
    let lastLocation = "";
    samples = samples.map(s => {
      if (s.material_location && s.material_location.trim() && s.material_location !== "<<carry>>") {
        lastLocation = s.material_location.trim();
        return s;
      } else if (s.material_location === "<<carry>>") {
        return { ...s, material_location: lastLocation };
      } else {
        return { ...s, material_location: "" };
      }
    });

    return samples.map(s => ({
      sample_number:        s.sample_number || "",
      ha_code:              s.ha_code || "",
      material_location:    s.material_location || "",
      material_description: s.material_description || "",
    }));
  };

  const processAll = async (fileList) => {
    if (!pdfReady || !fileList.length) return;
    setProcessing(true);
    setErrors([]);
    setRows([]);
    const allRows = [];
    const errs    = [];
    for (const f of fileList) {
      try {
        const r = await processPdf(f);
        allRows.push(...r);
      } catch (e) {
        errs.push(`${f.name}: ${e.message}`);
      }
    }
    setRows(allRows);
    setErrors(errs);
    setProcessing(false);
    setProgress(null);
  };

  const handleDrop = useCallback(e => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type === "application/pdf");
    if (dropped.length) { setFiles(dropped); processAll(dropped); }
  }, [pdfReady]);

  const handleFileChange = e => {
    const selected = Array.from(e.target.files).filter(f => f.type === "application/pdf");
    if (selected.length) { setFiles(selected); processAll(selected); }
  };

  const commitEdit = () => {
    if (!editCell) return;
    setRows(prev => prev.map((r, i) => i === editCell.rowIdx ? { ...r, [editCell.field]: editVal } : r));
    setEditCell(null);
  };

  const exportXlsx = () => {
    if (!xlsxReady || !rows.length) return;
    const headers = COLUMNS.map(c => c.label);
    const data    = rows.map(r => COLUMNS.map(c => r[c.key] || ""));
    const ws      = window.XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws["!cols"]   = COLUMNS.map(c => ({ wch: Math.round(c.width / 7) }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "COC Data");
    const ts = new Date().toISOString().slice(0, 10);
    window.XLSX.writeFile(wb, `COC_Export_${ts}.xlsx`);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", fontFamily: "'IBM Plex Sans','Segoe UI',sans-serif", color: "#e6edf3" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #161b22; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #484f58; }
        .cell-edit { background: #1c2128 !important; color: #e6edf3 !important; border: 1px solid #388bfd !important; outline: none; width: 100%; padding: 2px 6px; font-family: 'IBM Plex Mono',monospace; font-size: 12px; }
        .row-hover:hover td { background: #161b22 !important; }
        .btn-primary { background: #1f6feb; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-family: 'IBM Plex Sans',sans-serif; font-size: 13px; font-weight: 500; cursor: pointer; transition: background .15s; }
        .btn-primary:hover:not(:disabled) { background: #388bfd; }
        .btn-primary:disabled { opacity: .4; cursor: not-allowed; }
        .btn-ghost { background: transparent; color: #8b949e; border: 1px solid #30363d; padding: 8px 18px; border-radius: 6px; font-family: 'IBM Plex Sans',sans-serif; font-size: 13px; cursor: pointer; transition: all .15s; }
        .btn-ghost:hover { border-color: #8b949e; color: #e6edf3; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #21262d", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12, background: "#161b22" }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#1f6feb,#388bfd)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
          </svg>
        </div>
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 500, letterSpacing: "-0.02em" }}>PLM-FRM-010 · COC Extractor</div>
          <div style={{ fontSize: 11, color: "#8b949e", marginTop: 1 }}>Crystal Analytical LLC — Bulk Asbestos Chain of Custody</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {rows.length > 0 && (
            <button className="btn-ghost" onClick={() => { setRows([]); setFiles([]); setErrors([]); }}>Clear</button>
          )}
          <button className="btn-primary" onClick={exportXlsx} disabled={!rows.length || !xlsxReady}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export Excel
            </span>
          </button>
        </div>
      </div>

      <div style={{ padding: "20px 24px" }}>
        {/* Drop zone */}
        {!processing && rows.length === 0 && (
          <div
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? "#388bfd" : "#30363d"}`,
              borderRadius: 12, padding: "52px 24px", textAlign: "center", cursor: "pointer",
              transition: "all .2s", background: dragOver ? "rgba(31,111,235,.06)" : "#161b22",
              animation: "fadeIn .3s ease",
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 12, opacity: .5 }}>⊕</div>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Drop PLM COC PDFs here</div>
            <div style={{ fontSize: 12, color: "#8b949e" }}>or click to browse — multiple files supported</div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
              {["PLM-FRM-010", "Bulk Asbestos", "Multi-page OK", "Batch upload"].map(tag => (
                <span key={tag} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: "#21262d", color: "#8b949e", fontFamily: "'IBM Plex Mono',monospace" }}>{tag}</span>
              ))}
            </div>
            {!pdfReady && <div style={{ marginTop: 12, fontSize: 11, color: "#8b949e" }}>Loading PDF engine...</div>}
          </div>
        )}

        <input ref={fileInputRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={handleFileChange} />

        {/* Processing */}
        {processing && progress && (
          <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "32px 28px", animation: "fadeIn .3s ease" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#388bfd", animation: "pulse 1.2s infinite" }} />
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 }}>
                Processing <span style={{ color: "#388bfd" }}>{progress.file}</span>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 12 }}>
              Page {progress.page} of {progress.total} — Extracting COC fields via AI...
            </div>
            <div style={{ height: 4, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg,#1f6feb,#388bfd)", width: `${(progress.page / progress.total) * 100}%`, transition: "width .4s ease", borderRadius: 2 }} />
            </div>
            {files.length > 1 && (
              <div style={{ marginTop: 8, fontSize: 11, color: "#8b949e" }}>
                File {files.findIndex(f => f.name === progress.file) + 1} of {files.length}
              </div>
            )}
          </div>
        )}

        {/* Stats */}
        {rows.length > 0 && !processing && (
          <div style={{ display: "flex", gap: 12, marginBottom: 16, animation: "fadeIn .3s ease", flexWrap: "wrap" }}>
            {[
              { label: "Samples",   value: rows.length },
              { label: "COC Files", value: files.length },
              { label: "Errors",    value: errors.length, color: errors.length > 0 ? "#f85149" : undefined },
            ].map(stat => (
              <div key={stat.label} style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "10px 16px" }}>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 2 }}>{stat.label}</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 18, fontWeight: 500, color: stat.color || "#e6edf3" }}>{stat.value}</div>
              </div>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => fileInputRef.current?.click()}>+ Add more PDFs</button>
            </div>
          </div>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <div style={{ background: "rgba(248,81,73,.08)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 8, padding: "12px 16px", marginBottom: 16 }}>
            {errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: "#f85149", fontFamily: "'IBM Plex Mono',monospace" }}>{e}</div>)}
          </div>
        )}

        {/* Table */}
        {rows.length > 0 && !processing && (
          <div style={{ border: "1px solid #21262d", borderRadius: 10, overflow: "hidden", animation: "fadeIn .4s ease" }}>
            <div style={{ overflowX: "auto", maxHeight: "calc(100vh - 340px)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 40 }}>#</th>
                    {COLUMNS.map(c => <th key={c.key} style={{ ...thStyle, minWidth: c.width }}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri} className="row-hover" style={{ borderBottom: "1px solid #21262d" }}>
                      <td style={{ ...tdStyle, color: "#8b949e", textAlign: "center", background: "#161b22" }}>{ri + 1}</td>
                      {COLUMNS.map(col => {
                        const isEditing = editCell?.rowIdx === ri && editCell?.field === col.key;
                        const val = row[col.key] || "";
                        return (
                          <td key={col.key} style={{ ...tdStyle, cursor: "text", maxWidth: col.width }}
                            onDoubleClick={() => { setEditCell({ rowIdx: ri, field: col.key }); setEditVal(val); }}>
                            {isEditing ? (
                              <input ref={editRef} className="cell-edit" value={editVal}
                                onChange={e => setEditVal(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditCell(null); }} />
                            ) : (
                              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                fontFamily: col.key === "sample_number" ? "'IBM Plex Mono',monospace" : undefined,
                                color: col.key === "sample_number" ? "#79c0ff" : undefined, maxWidth: col.width }}>
                                {val || <span style={{ color: "#484f58" }}>—</span>}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: "8px 16px", borderTop: "1px solid #21262d", background: "#161b22", fontSize: 11, color: "#8b949e", display: "flex", justifyContent: "space-between" }}>
              <span>{rows.length} sample rows · Double-click any cell to edit</span>
              <span>Sample Number · HA · Material Location · Material Description</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle = {
  background: "#161b22", padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600,
  color: "#8b949e", borderBottom: "1px solid #21262d", position: "sticky", top: 0,
  whiteSpace: "nowrap", letterSpacing: "0.04em", textTransform: "uppercase", zIndex: 1,
};
const tdStyle = { padding: "7px 12px", fontSize: 12, color: "#e6edf3", verticalAlign: "middle" };
