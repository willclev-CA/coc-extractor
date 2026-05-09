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

export default async (req) => {
  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { image_base64, page_num, total_pages, filename } = body;
  if (!image_base64) {
    return new Response(JSON.stringify({ error: "Missing image_base64" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: EXTRACT_SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image_base64 } },
          { type: "text", text: `Page ${page_num} of ${total_pages} — file: ${filename}. Extract the sample table.` }
        ]
      }]
    })
  });

  const data = await anthropicResp.json();
  const txt = data.content?.find(b => b.type === "text")?.text || "{}";

  let parsed;
  try {
    parsed = JSON.parse(txt.replace(/```json\n?|```/g, "").trim());
  } catch {
    parsed = { samples: [] };
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = { path: "/api/extract" };
