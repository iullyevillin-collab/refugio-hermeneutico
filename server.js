import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const DB_FILE = path.resolve('data/db.json');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const API_KEY = process.env.OPENAI_API_KEY;

// ---------- Persistência (arquivo JSON local) ----------
async function loadDb() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch {
    return { readings: [] };
  }
}
async function saveDb(db) {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- Prompts ----------
const SYSTEM_PROMPT = `Você é um tutor de leitura hermenêutica, dialógico e socrático, em português do Brasil.

REGRAS:
1. Baseie toda avaliação PRIMEIRO no trecho original fornecido. Não substitua o pensamento do autor por conhecimento genérico.
2. Ao receber a resposta da estudante, compare-a com o trecho. Diga o que está correto, aponte confusões entre conceitos (X e Y), mostre nuances que o texto apresenta e diga quando uma conclusão não aparece no trecho.
3. Se o trecho não tiver informação suficiente para avaliar algo, diga isso explicitamente.
4. Faça perguntas abertas e específicas sobre o trecho, nunca de sim/não. Faça UMA pergunta por vez. Considere o histórico para não repetir perguntas e para aprofundar o que a estudante já disse.
5. Se a resposta estiver curta, confusa ou equivocada, não avance: peça que ela repense uma passagem específica.
6. Use um tom acolhedor, direto e conciso. Não resuma o texto inteiro.
7. Indique em "compreensao_adequada" true somente quando a estudante já mostrar compreensão do conceito central e das relações do trecho.

Responda SEMPRE em JSON com as chaves:
- "mensagem": texto a ser mostrado à estudante (correção, nuance e/ou próxima pergunta)
- "compreensao_adequada": booleano
- "conceitos": lista de conceitos-chave identificados no trecho ou nas respostas
- "dificuldades": lista de confusões ou dificuldades observadas na estudante (pode ser vazia)`;

const FICHAMENTO_PROMPT = `Com base no trecho original e em TODO o diálogo, gere o fichamento hermenêutico em português do Brasil.
Priorize as palavras e a interpretação da estudante. Não substitua a interpretação dela por um resumo genérico. Use somente informações do trecho e do diálogo.

Responda em JSON com as chaves:
- "tese_central": string
- "interpretacao_refinada": string (a interpretação da estudante, refinada e fiel às palavras dela)
- "conceitos_chave": lista de objetos {"conceito": string, "definicao": string}
- "compreendeu_corretamente": lista de strings
- "correcoes": lista de strings (conceitos corrigidos durante o diálogo)
- "nuances": lista de strings
- "pergunta_revisao": string`;

// Bloco fixo de contexto: o trecho original vai em TODA chamada.
function contextBlock(r) {
  return `OBRA: ${r.obra}
AUTOR: ${r.autor}
CAPÍTULO/PARTE: ${r.cap || 'não informado'}
TEMA/CONCEITO ESTUDADO: ${r.tema || 'não informado'}

TRECHO ORIGINAL:
"""
${r.trecho}
"""`;
}

// ---------- Chamada à API real ----------
async function callLLM(messages) {
  if (!API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Coloque sua chave no arquivo .env e reinicie o servidor.');
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.4,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Erro da API (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Monta o histórico completo para o modelo: sistema + trecho + todos os turnos.
function buildMessages(r, extraInstruction = null) {
  const msgs = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: contextBlock(r) }
  ];
  for (const t of r.turns) {
    msgs.push({ role: t.role, content: t.content });
  }
  if (extraInstruction) msgs.push({ role: 'user', content: extraInstruction });
  return msgs;
}

function mergeUnique(a = [], b = []) {
  return [...new Set([...a, ...b].filter(Boolean))];
}

// ---------- Rotas ----------

// Lista todas as leituras
app.get('/api/readings', async (req, res) => {
  const db = await loadDb();
  res.json(db.readings.map(r => ({
    id: r.id, obra: r.obra, autor: r.autor, cap: r.cap, tema: r.tema,
    status: r.status, createdAt: r.createdAt
  })));
});

// Detalhe de uma leitura
app.get('/api/readings/:id', async (req, res) => {
  const db = await loadDb();
  const r = db.readings.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ erro: 'Leitura não encontrada' });
  res.json(r);
});

// Nova leitura: a IA lê o trecho e faz a primeira pergunta
app.post('/api/readings', async (req, res) => {
  try {
    const { obra, autor, cap = '', tema = '', trecho } = req.body;
    if (!obra || !autor || !trecho) {
      return res.status(400).json({ erro: 'Obra, autor e trecho são obrigatórios.' });
    }
    const r = {
      id: crypto.randomUUID(),
      obra, autor, cap, tema, trecho,
      turns: [],
      conceitos: [],
      dificuldades: [],
      status: 'dialogo',
      fichamento: null,
      createdAt: new Date().toISOString()
    };
    const instrucao = 'Leia o trecho, identifique o conceito central em uma linha e faça a PRIMEIRA pergunta socrática (compreensão do que o autor afirma). Não faça resumo.';
    const out = await callLLM(buildMessages(r, instrucao));

    r.turns.push({ role: 'assistant', content: out.mensagem });
    r.conceitos = mergeUnique(r.conceitos, out.conceitos);
    r.dificuldades = mergeUnique(r.dificuldades, out.dificuldades);

    const db = await loadDb();
    db.readings.unshift(r);
    await saveDb(db);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Resposta da estudante: a IA compara com o trecho e conduz o diálogo
app.post('/api/readings/:id/answer', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Escreva uma resposta.' });

    const db = await loadDb();
    const r = db.readings.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ erro: 'Leitura não encontrada' });

    r.turns.push({ role: 'user', content: texto.trim() });
    const out = await callLLM(buildMessages(r,
      'Avalie a última resposta da estudante comparando-a com o trecho original. Corrija, complemente, mostre nuances ou peça que repense uma passagem. Faça no máximo uma pergunta nova. Responda no formato JSON definido.'));

    r.turns.push({ role: 'assistant', content: out.mensagem });
    r.conceitos = mergeUnique(r.conceitos, out.conceitos);
    r.dificuldades = mergeUnique(r.dificuldades, out.dificuldades);
    r.compreensaoAdequada = !!out.compreensao_adequada;
    r.status = r.compreensaoAdequada ? 'pronto_para_fichamento' : 'dialogo';

    await saveDb(db);
    res.json({ ...r, ultimaMensagem: out.mensagem });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Gera o fichamento a partir do trecho e do diálogo
app.post('/api/readings/:id/fichamento', async (req, res) => {
  try {
    const db = await loadDb();
    const r = db.readings.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ erro: 'Leitura não encontrada' });
    if (r.turns.length < 2) return res.status(400).json({ erro: 'Converse um pouco mais antes de gerar o fichamento.' });

    const fich = await callLLM(buildMessages(r, FICHAMENTO_PROMPT));
    r.fichamento = { ...fich, obra_autor: `${r.obra} — ${r.autor}${r.cap ? ' (' + r.cap + ')' : ''}`, trecho: r.trecho };
    r.status = 'concluida';
    await saveDb(db);
    res.json(r.fichamento);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Apagar uma leitura
app.delete('/api/readings/:id', async (req, res) => {
  const db = await loadDb();
  db.readings = db.readings.filter(x => x.id !== req.params.id);
  await saveDb(db);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Leitura Hermenêutica em http://localhost:${PORT}`));