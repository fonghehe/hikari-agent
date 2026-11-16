/** Fictional, offline keyword regression set; not evidence of live embedding relevance. */
export const retrievalDocuments = [
  {
    text: '退款政策：退货时必须提交原始收据，退款到账时间为五个工作日。',
    metadata: { id: 'refund', label: 'Policy 1' },
  },
  {
    text: 'Shipping policy: expedited delivery takes two business days. International shipping requires customs forms.',
    metadata: { id: 'shipping', label: 'Policy 2' },
  },
  {
    text: 'Backup retention: database snapshots are retained for thirty days. Restore requires an integrity check.',
    metadata: { id: 'backup', label: 'Operations 1' },
  },
  {
    text: 'Security policy: API credentials must be rotated quarterly. Audit logs have a retention period of ninety days.',
    metadata: { id: 'security', label: 'Operations 2' },
  },
  {
    text: '設定の変更は保存ボタンで確定します。言語設定は再起動なしで変更できます。',
    metadata: { id: 'settings', label: 'Guide 1' },
  },
  {
    text: 'Invoice rounding: round monetary totals to two decimal places using decimal arithmetic.',
    metadata: { id: 'invoice', label: 'Finance 1' },
  },
  {
    text: '故障处理：连接超时后可以重试三次。证书错误需要先修复服务端证书。',
    metadata: { id: 'connection', label: 'Troubleshooting 1' },
  },
  {
    text: 'Product catalog: green tea is available in loose leaf packages. Store away from direct sunlight.',
    metadata: { id: 'tea', label: 'Catalog 1' },
  },
];
export const retrievalCases: { query: string; relevant: string[] }[] = [
  { query: '原始收据', relevant: ['refund'] },
  { query: '退款到账时间', relevant: ['refund'] },
  { query: 'expedited delivery', relevant: ['shipping'] },
  { query: 'customs forms', relevant: ['shipping'] },
  { query: 'database snapshots', relevant: ['backup'] },
  { query: 'restore integrity check', relevant: ['backup'] },
  { query: 'credentials rotated quarterly', relevant: ['security'] },
  { query: 'audit logs', relevant: ['security'] },
  { query: '言語設定', relevant: ['settings'] },
  { query: '保存ボタン', relevant: ['settings'] },
  { query: 'invoice rounding', relevant: ['invoice'] },
  { query: 'decimal arithmetic', relevant: ['invoice'] },
  { query: '连接超时', relevant: ['connection'] },
  { query: '服务端证书', relevant: ['connection'] },
  { query: 'green tea', relevant: ['tea'] },
  { query: 'direct sunlight', relevant: ['tea'] },
  { query: 'retention', relevant: ['backup', 'security'] },
  { query: 'ＤＥＬＩＶＥＲＹ', relevant: ['shipping'] },
  { query: 'volcanic basalt mineral', relevant: [] },
  { query: '月球火山岩', relevant: [] },
];
