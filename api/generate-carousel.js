export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { nicho, cliente_ideal } = req.body || {};
  if (!nicho || !cliente_ideal) {
    return res.status(400).json({ error: 'Faltan datos: nicho y cliente_ideal son obligatorios' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!geminiKey) {
    return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
  }

  const prompt = `Eres un experto en marketing de contenidos para redes sociales en español. Escribe con tono directo, energético y coloquial, como si le hablaras a un amigo — nada de lenguaje corporativo ni frases largas y explicativas. Usa frases cortas, contundentes, con ritmo. Prioriza el gancho y la urgencia por encima de la formalidad. Evita sonar como un informe: suena como alguien que quiere vender ya. Basado en este negocio: "${nicho}" y este cliente ideal: "${cliente_ideal}", genera lo siguiente.

1) Un carrusel viral de exactamente 7 slides para Instagram con esta estructura: Slide 1 Gancho que capture atención en una frase corta. Slide 2 Dato o estadística que genere urgencia. Slide 3 Error común que comete la audiencia. Slide 4 Por qué pasa ese error o un reencuadre de la situación. Slide 5 La solución o un tip accionable y concreto. Slide 6 Prueba social o caso de éxito breve y creíble. Slide 7 Llamado a la acción pidiendo comentar una palabra clave para recibir algo gratis.

2) Un copy de publicación listo para pegar, adaptado a cada red social, resumiendo la idea del carrusel:
- instagram: con emojis, gancho en la primera línea, y entre 5 y 8 hashtags relevantes en español al final.
- tiktok: corto, tono casual, máximo 3 hashtags, enfocado en generar comentarios.
- facebook: entre 3 y 4 líneas, tono cercano, sin exceso de hashtags.

3) Para cada una de las 7 slides, una frase corta de 2 a 4 palabras EN INGLÉS para buscar una foto de stock que combine con el contenido específico de esa slide (sé concreto al tema de esa slide puntual, evita palabras genéricas sueltas como "business" o "technology"). Si la búsqueda de la slide incluye una persona, agrega siempre la palabra "latina" o "hispanic" en inglés dentro de la frase de búsqueda, para priorizar fotos de personas de apariencia latinoamericana.

Responde ÚNICAMENTE con un JSON válido, sin explicaciones, sin texto antes ni después, exactamente con esta estructura:
{"titulo_carrusel": "string", "slides": [{"numero": 1, "tipo": "Gancho", "texto": "string", "busqueda_imagen": "string"}, {"numero": 2, "tipo": "Dato", "texto": "string", "busqueda_imagen": "string"}, {"numero": 3, "tipo": "Error", "texto": "string", "busqueda_imagen": "string"}, {"numero": 4, "tipo": "Reencuadre", "texto": "string", "busqueda_imagen": "string"}, {"numero": 5, "tipo": "Solución", "texto": "string", "busqueda_imagen": "string"}, {"numero": 6, "tipo": "Prueba social", "texto": "string", "busqueda_imagen": "string"}, {"numero": 7, "tipo": "CTA", "texto": "string", "busqueda_imagen": "string"}], "copys": {"instagram": "string", "tiktok": "string", "facebook": "string"}}`;

  // Gemini a veces responde 503 "modelo con mucha demanda" o 429 "rate limit" —
  // son errores pasajeros del lado de Google, no de nuestra configuración.
  // Reintentamos un par de veces con una pequeña espera antes de rendirnos.
  async function llamarGemini(intentos = 3) {
    for (let intento = 1; intento <= intentos; intento++) {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        }
      );

      if (resp.ok) return resp;

      const esReintentable = resp.status === 503 || resp.status === 429;
      if (!esReintentable || intento === intentos) return resp;

      const espera = 1200 * intento; // 1.2s, luego 2.4s
      console.error(`Gemini respondió ${resp.status}, reintentando en ${espera}ms (intento ${intento}/${intentos})`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }

  let parsed;
  try {
    const geminiResp = await llamarGemini();

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      console.error('Error de Gemini:', errText);
      const esSobrecarga = geminiResp.status === 503 || geminiResp.status === 429;
      return res.status(502).json({
        error: esSobrecarga
          ? 'La IA está saturada en este momento, intenta de nuevo en unos segundos'
          : 'Error al generar el carrusel con la IA',
        detalle: errText
      });
    }

    const geminiData = await geminiResp.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.status(502).json({ error: 'La IA no devolvió contenido', detalle: JSON.stringify(geminiData) });
    }

    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw e;
      }
    }
  } catch (err) {
    console.error('Error generando el carrusel:', err);
    return res.status(500).json({ error: 'Error interno generando el carrusel', detalle: String(err && err.message ? err.message : err) });
  }

  // Busca una foto real en Pexels para cada slide. Si Pexels falla o no hay
  // API key configurada, la slide simplemente queda sin foto_url — el frontend
  // ya sabe mostrar la slide sin foto de fondo en ese caso.
  const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
  if (pexelsKey) {
    await Promise.all(
      slides.map(async (slide) => {
        try {
          const query = encodeURIComponent(slide.busqueda_imagen || '');
          const pexelsResp = await fetch(
            `https://api.pexels.com/v1/search?query=${query}&per_page=1&orientation=portrait`,
            { headers: { Authorization: pexelsKey } }
          );
          if (!pexelsResp.ok) return;
          const pexelsData = await pexelsResp.json();
          const foto = pexelsData?.photos?.[0]?.src?.portrait;
          if (foto) slide.foto_url = foto;
        } catch (e) {
          console.error('Error buscando foto en Pexels para slide', slide.numero, e);
        }
      })
    );
  }

  return res.status(200).json({
    titulo_carrusel: parsed.titulo_carrusel,
    slides,
    copys: parsed.copys
  });
}
