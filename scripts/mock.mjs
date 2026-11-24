// Dados fictícios para visualizar o painel sem acessar o Bitrix24 (npm run demo).
export const offices = [{ login: 'demo', password: 'demonstracao-2026', companyIds: [1], officeValues: [], name: 'Escritório Demonstração Advogados' }];

const stages = [
  { id: 'C17:NEW', name: 'Novo chamado', color: '#2FC6F6', sem: 'P' },
  { id: 'C17:PREPARATION', name: 'Em análise', color: '#55D0E0', sem: 'P' },
  { id: 'C17:EXECUTING', name: 'Em atendimento', color: '#47E4C2', sem: 'P' },
  { id: 'C17:UC_WAIT', name: 'Aguardando cliente', color: '#FFA900', sem: 'P' },
  { id: 'C17:WON', name: 'Resolvido', color: '#7BD500', sem: 'S' },
  { id: 'C17:LOSE', name: 'Cancelado', color: '#FF5752', sem: 'F' },
];
const fields = [
  { code: 'TYPE_ID', label: 'Tipo', type: 'crm_status', filter: true },
  { code: 'UF_PRIORIDADE', label: 'Prioridade', type: 'enumeration', filter: true },
  { code: 'UF_PRODUTO', label: 'Produto', type: 'enumeration', filter: true },
  { code: 'UF_PRAZO', label: 'Previsão de entrega', type: 'date', filter: false },
  { code: 'UF_LINK', label: 'Link de referência', type: 'url', filter: false },
  { code: 'UF_PENDENTE', label: 'Informações pendentes', type: 'string', filter: false },
  { code: 'UF_FEITO', label: 'O que foi feito', type: 'string', filter: false },
];
const tipos = ['Dúvida', 'Erro', 'Melhoria', 'Nova automação'];
const prioridades = ['Baixa', 'Média', 'Alta'];
const produtos = ['CRM Bitrix24', 'Automações n8n', 'BI', 'WhatsApp', 'IA de prazos'];
const contatos = ['Ana Ribeiro', 'Carlos Menezes', 'Fernanda Lopes', 'João Prado'];
const equipe = ['Bruno (Suporte)', 'Camila (Suporte)', 'Diego (Implementação)'];
const titulos = [
  'Automação de boas-vindas não disparou', 'Ajustar campo de valor da causa', 'Dashboard de produtividade sem dados de outubro',
  'Criar etapa "Aguardando perícia" no funil', 'Mensagem de WhatsApp com variável em branco', 'Dúvida sobre relatório de prazos',
  'Usuário novo sem acesso ao CRM', 'Intimação lançada em duplicidade', 'Incluir filtro por advogado no BI', 'Robô de cobrança enviando fora do horário',
  'Importar planilha de processos antigos', 'Erro ao gerar documento pelo modelo', 'Alterar responsável padrão dos leads', 'Integração do financeiro parou de sincronizar',
];

export function payloads(config) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const deals = titulos.map((title, i) => {
    const created = now - (i * 2 + 1) * 864e5 - i * 37e5;
    const stage = stages[i % stages.length];
    const n = i % 4;
    return {
      id: 4800 + i * 7,
      title,
      stage: stage.id,
      contact: contatos[i % contatos.length],
      assigned: equipe[i % equipe.length],
      created: iso(created),
      modified: iso(created + 5e7 + i * 3e6),
      pri: (i % 5) + 1,
      sla: i % 4 === 3 ? null : { type: 'Alteração', size: ['pequeno porte', 'médio porte', 'grande porte'][i % 3], note: '', min: [1, 5, 10][i % 3], max: [1, 5, 10][i % 3] },
      desc: `Solicitação registrada pelo escritório.\n\n${title}. Segue o detalhamento enviado pelo solicitante para análise da equipe.`,
      v: {
        TYPE_ID: tipos[i % tipos.length],
        UF_PRIORIDADE: prioridades[i % prioridades.length],
        UF_PRODUTO: produtos[i % produtos.length],
        ...(i % 3 ? { UF_PRAZO: iso(now + (i + 2) * 864e5).slice(0, 10) } : {}),
        ...(i % 5 === 0 ? { UF_LINK: 'https://exemplo.com.br/referencia' } : {}),
        ...(stage.id === 'C17:UC_WAIT' ? { UF_PENDENTE: 'Aguardando o escritório enviar um exemplo do caso para reproduzirmos.' } : {}),
        ...(stage.sem === 'S' ? { UF_FEITO: 'Identificamos a causa, aplicamos o ajuste na automação e validamos com um caso de teste.\nO fluxo voltou a funcionar normalmente.' } : {}),
      },
      comments: Array.from({ length: n }, (_, k) => ({
        a: equipe[(i + k) % equipe.length],
        d: iso(created + (k + 1) * 36e5 * 5),
        t: ['Chamado recebido, iniciamos a análise.', 'Identificamos a causa e estamos aplicando o ajuste.', 'Ajuste aplicado. Pode validar, por favor?'][k],
      })),
    };
  });
  const payload = {
    office: { name: offices[0].name },
    generatedAt: new Date().toISOString(),
    product: config.productName || 'Suporte',
    cardField: 'TYPE_ID',
    noteField: 'UF_PENDENTE',
    closedDays: 90,
    priority: config.priority ? { label: config.priority.label, levels: config.priority.levels } : null,
    sla: config.sla ? { legend: config.sla.legend, footnote: config.sla.footnote } : null,
    stages, fields, deals,
  };
  return new Map([['demo', payload]]);
}
