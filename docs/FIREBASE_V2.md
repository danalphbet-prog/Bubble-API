# Bubble API v2 — Firebase RTDB + sessões por instância

Esta versão é um **acréscimo** à Bubble-API v1.3. As rotas `/v1/...` são mantidas;
nenhuma posição XYZ é escrita no Firebase pela API. As posições ficam em RAM e
expiram após `BUBBLE_V2_PLAYER_TTL_MS` (padrão: 2,5 segundos).

## Requisitos

- Node.js 22+ (`firebase-admin` v14), `npm install`.
- Projeto Firebase: `worknow-be4bd`.
- RTDB: `https://worknow-be4bd-default-rtdb.firebaseio.com`.
- Firebase Authentication anônimo habilitado (o app Android já autentica).
- Render: variável **secreta** `FIREBASE_SERVICE_ACCOUNT_JSON_B64` com a chave JSON da conta de serviço,
  codificada em base64 numa única linha. Não usar `apiKey` Web como se fosse chave Admin.
- Manifesto existente em `/bubble/manifests/cidade`, instância `/bubble/instances/bubble-N001z`.
- O app precisa estar online com presença `/bubble/bds/{firebaseUid}` e membro
  `/bubble/instances/bubble-N001z/members/{firebaseUid}/{uuid}=true`.

### Onde obter a chave privada

Firebase Console → ⚙ Configurações do projeto → Contas de serviço → Gerar nova chave privada.
Baixe o arquivo JSON e **não o coloque no repositório**.
No Termux:

```sh
base64 -w 0 ~/storage/downloads/serviceAccountKey.json
```

Copie a saída completa para a variável `FIREBASE_SERVICE_ACCOUNT_JSON_B64` no Render.
A credencial exige acesso à leitura do Realtime Database e verificação de Firebase Auth;
proteja-a com permissões mínimas, rotacione se vazada e não compartilhe prints do valor.

No Render, configure também as outras variáveis de `render_env_copiar.txt`.
`NODE_VERSION=22.16.0` e `npm install --omit=dev && npm run check` estão em `render.yaml` após o patch.

## Autenticação v2

Todas as rotas v2 privadas usam um **Firebase ID token** real obtido pelo BubbleBDSHost.
Enviado como `Authorization: Bearer FIREBASE_ID_TOKEN`. O token é renovado pelo app quando expira.
`bdsId` deve ser exatamente o Firebase UID presente no token e no Firebase RTDB.
Não se usa `server_key` da v1 para autorizar a v2.

A API valida:
1. Firebase ID token;
2. `/bubble/bds/{uid}` com `online=true`, `instanceId` igual e `lastSeen` recente;
3. associação existente de membros em `/bubble/instances/{instanceId}/members/{uid}`;
4. para publicar, presença de `playerId` dentro dessa associação;
5. dimensão igual ao `numericDimensionId` do manifesto.

Como a versão atual do app permite associação de membros pelo cliente autenticado anonimamente,
**esta etapa é um MVP, não uma rede anti-fraude**: um cliente modificado pode alterar seus próprios membros no Firebase.
Para produção: migrar reserva/entrada/saída à API, aplicar App Check/atestado e autorização
por BDS provisionado. O Admin SDK ignora as regras RTDB, por isso as validações da API são necessárias.

## Rotas HTTP

| Método | Rota | Observação |
|---|---|---|
| GET | `/v2/healthz` | Status do módulo, sem dados privados |
| POST | `/v2/state/publish` | Publicação de posição, rotações, dimensão |
| GET | `/v2/instances/:instanceId/players` | Só jogadores da instância do solicitante |
| GET | `/v2/instances/:instanceId/members` | IDs por BDS, sem XYZ |
| GET | `/v2/instances/:instanceId/manifest` | Regras editáveis do Firebase |
| POST | `/v2/access/grant` | Token temporário somente leitura para receptor |
| WS | `/v2/live` | Inscrição/recepção em tempo real; aceita publicação autenticada |

Exemplo de publicação (BDS e UUID devem existir no RTDB):

```http
POST /v2/state/publish HTTP/1.1
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json
```
```json
{
  "instanceId": "bubble-N001z",
  "bdsId": "FIREBASE_UID_DO_SEU_BDS",
  "playerId": "6df9637b-e017-4e8b-b637-ada80299c9a6",
  "state": {
    "dimension": 1000,
    "id": -68719476716,
    "uniqueId": "6df9637b-e017-4e8b-b637-ada80299c9a6",
    "position": { "x": 1.9208062887, "y": 68.6200103759, "z": -1.8047109842 },
    "yRot": 50.5970458984
  }
}
```

### GET `/v2/instances/bubble-N001z/players`

Retorna apenas estados remotos de outros BDS na mesma instância.
Por padrão **não retorna os jogadores do BDS que fez a consulta**, pois eles são nativos nesse mundo.
Para teste local, acrescente `?include_self=1`, mantendo autenticação e associação obrigatórias.
A resposta retorna no máximo `BUBBLE_V2_MAX_REMOTES` estados (8 por padrão), com `count`
informando quantos estados ativos poderiam ser entregues.

### GET `/v2/instances/bubble-N001z/members`

Retorna `instanceId`, `count`, `members:[{bdsId,playerId}]`, sem coordenadas.

### GET `/v2/instances/bubble-N001z/manifest`

Retorna `instanceId`, `manifestId`, `manifest` com `revision`, regras e dimensão numérica
lidos do Firebase, em cache por até 5 segundos.
Esta rota permite consultar manifesto se o BDS está autorizado online, mesmo antes de existir
jogador na dimensão.

## WebSocket

Endpoint: `wss://bubble-api-8dyc.onrender.com/v2/live`.

O app pode autenticar-se enviando após abrir o socket:

```json
{"type":"auth","token":"FIREBASE_ID_TOKEN","instanceId":"bubble-N001z"}
```

Depois pode publicar com `type=publish` e o restante do mesmo JSON da rota HTTP:

```json
{"type":"publish","instanceId":"bubble-N001z","bdsId":"FIREBASE_UID_DO_BDS","playerId":"6df9637b-e017-4e8b-b637-ada80299c9a6","state":{"dimension":1000,"uniqueId":"6df9637b-e017-4e8b-b637-ada80299c9a6","position":{"x":1,"y":68,"z":2},"yRot":50}}
```

O receptor é notificado com mensagens `type=state` somente para outros BDS da mesma instância.
O emissor recebe `type=ack`. Inclui `type=ping`/`pong`.

**Token de receptor:** o aplicativo chama `POST /v2/access/grant` autenticado com Firebase
ID token e corpo `{"instanceId":"bubble-N001z"}`. A API devolve token aleatório
somente leitura com duração padrão de 5 minutos. Entregue esse token ao addon por canal
local confiável. O addon então autentica no WS com a mesma mensagem `type=auth`, mas
usando o token temporário. Ao expirar, precisa obter outro. Não envie token no URL ou logs.

**Importante:** este patch atualiza **a API**. Ele não implementa automaticamente o envio
HTTP/WebSocket dentro do aplicativo nem a conexão WS do addon; esses clientes precisarão
ser atualizados para usar estas rotas. Verifique a disponibilidade do WebSocket em
`@minecraft/server-net` para a versão específica do BDS antes de integrar o addon.

## Teste local sem Firebase real

```sh
npm run check
npm test
```

Os testes usam memória falsa para simular Firebase e verificam acesso entre instâncias.
Para testar a integração real é obrigatório configurar uma conta de serviço válida no Render.

## Segurança e escala

- Nunca armazenar Firebase Service Account privada dentro do APK, addon ou repositório Git.
- NÃO publicar `FIREBASE_SERVICE_ACCOUNT_JSON_B64` em logs, comentários ou mensagens.
- App hospeda BDS e autentica Firebase; API verifica Firebase ID token e associação.
- O ID da instância sozinho nunca garante autorização.
- Cada publicação de jogador tem limite de 15/s por `playerId` e BDS autenticado.
- O limite de 8 é de hologramas retornados a cada BDS, não quantidade de membros da instância.
- A API usa RAM local: reinício do Render limpa os estados; cada app envia novamente ao reconectar.
- Em múltiplas réplicas Render, é necessário pub/sub compartilhado (Redis/NATS) para WS e estados.
- O heartbeat do BDS existente pode ficar 30 s; o servidor invalida BDS sem `lastSeen` em 90 s.
- O WS manda apenas *atualizações novas*; ao conectar, o receptor pode fazer GET `/players`
  para obter o snapshot inicial.
