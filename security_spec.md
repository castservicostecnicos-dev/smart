# Especificação de Segurança Multi-Empresa — Gestão Inteligente Empresarial

## 1. Invariantes de Dados (Data Invariants)
1. **Isolamento Estrito por Empresa (Multiempresa)**: Todos os dados de negócio residem em subcoleções sob `/companies/{companyId}/...` e também carregam `companyId` correspondente ao caminho. O acesso só é concedido a usuários verificados com vínculo ativo em `/companies/{companyId}/members/{uid}`.
2. **Autenticação Verificada Obrigatória**: Nenhuma leitura ou escrita ocorre sem `request.auth != null && request.auth.token.email_verified == true`.
3. **Separação de Perfis RBAC**:
   - `ADMINISTRADOR`: acesso completo dentro da sua empresa (usuários, convites, configurações, financeiro, notas, conciliação, estoque, relatórios, documentos).
   - `FINANCEIRO`: escrita restrita a `financialTransactions`, `invoices`, `bankTransactions`, `reconciliations`, `reports`, e documentos nas pastas `fiscal`, `financeiro`, `conciliacao`, `relatorios`. Bloqueado de alterar `products`, `stockMovements`, `members` e configurações da empresa.
   - `ESTOQUE`: escrita restrita a `products`, `stockMovements`, `reports`, e documentos na pasta `estoque` / `relatorios`. Bloqueado de alterar financeiro, notas fiscais, conciliações, membros e configurações.
   - `CONSULTA`: estritamente **somente leitura** em Firestore e Storage (`create`, `update`, `delete` bloqueados).
4. **Convites Seguros e Anti-Autopromoção**: Um usuário só entra em uma empresa existente se houver um convite válido e pendente em `/invites/{inviteId}` emitido por um administrador para o seu e-mail verificado, mantendo exatamente o `role` definido no convite.
5. **Integridade de Identidade e Tempo**: `ownerId == request.auth.uid` na criação e imutável em updates; `createdAt == request.time`, `updatedAt == request.time`, `createdAt` imutável.
6. **Sincronização Atômica e Imutabilidade**: `stockMovements` exige `existsAfter` no produto correspondente em `/companies/{companyId}/products/{productId}` e bloqueia edição/exclusão. `auditLogs` é estritamente append-only.
7. **Proteção de Arquivos no Firebase Storage (`storage.rules`)**: Arquivos isolados em `/companies/{companyId}/{pasta}/{arquivo}`, limite de 10 MB, tipos permitidos (`xml`, `csv`, `ofx`, `pdf`, `xlsx`, `xls`, `txt`, `json`), leitura apenas para membros ativos da empresa e escrita restringida por papel (`ADMINISTRADOR`, `FINANCEIRO`, `ESTOQUE`; `CONSULTA` bloqueado).

## 2. Payloads Adversariais ("Dirty Dozen")
1. **Cross-Tenant Read**: Usuário da Empresa A tenta `get` ou `list` em `/companies/empresa-B/products` -> Rejeitado por ausência de vínculo ativo em `/companies/empresa-B/members/{uid}`.
2. **Cross-Role Escalation (`ESTOQUE` -> Financeiro)**: Usuário `ESTOQUE` tenta criar documento em `/companies/{id}/invoices` -> Rejeitado por `canWriteFinancial(companyId)`.
3. **Cross-Role Escalation (`FINANCEIRO` -> Estoque)**: Usuário `FINANCEIRO` tenta atualizar saldo em `/companies/{id}/products/{prodId}` -> Rejeitado por `canWriteInventory(companyId)`.
4. **Read-Only Bypass (`CONSULTA`)**: Usuário `CONSULTA` tenta `create`, `update` ou `delete` em qualquer subcoleção ou Storage -> Rejeitado por todas as regras de escrita.
5. **Invite Spoofing / Role Forgery**: Usuário convidado como `CONSULTA` tenta criar `/companies/{id}/members/{uid}` com `role: "ADMINISTRADOR"` -> Rejeitado pela verificação `get(/invites/$(inviteId)).data.role == incoming().role`.
6. **Shadow Field Injection**: Payload com campos extras não declarados (`"isAdmin": true`) -> Rejeitado por `hasOnly(...)`.
7. **Owner Spoofing**: Criar item com `ownerId` de outro usuário -> Rejeitado por `incoming().ownerId == request.auth.uid`.
8. **Unverified Email Bypass**: Token com e-mail administrativo mas `email_verified: false` -> Rejeitado por `request.auth.token.email_verified == true`.
9. **ID Poisoning & Payload Exhaustion**: Document ID inválido ou strings > limite -> Rejeitado por `isValidId` e `.size()`.
10. **Orphan Stock Movement**: Movimentação referenciando `productId` inexistente -> Rejeitado por `existsAfter`.
11. **Terminal State Mutation**: Não-administrador tentando editar NF `cancelada` ou lançamento `cancelado` -> Rejeitado.
12. **Audit Tampering / Storage Bypass**: Tentativa de `update`/`delete` em `auditLogs` ou upload > 10 MB / `.exe` no Storage -> Rejeitado.
