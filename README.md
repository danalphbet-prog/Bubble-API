# Bubble API Beta — 0.1.0

**Objetivo:** testar o transporte de dados do Minecraft entre BDS, API e futuro addon receptor, sem cadastro, Firebase, IDs autorizados ou tokens.

A API **não transforma coordenadas**, **não espelha**, **não anima**, **não cria SimulatedPlayer**. Essas tarefas serão do addon receptor. A API apenas valida tipos básicos, guarda o último estado de cada jogador por aproximadamente **3 segundos na RAM** e transmite o mesmo estado por WebSocket.

> ⚠️ Protótipo público sem autenticação: qualquer pessoa que conheça o endereço pode publicar estados ou lê-los. Não usar para dados sensíveis, jogadores reais em produção ou servidores públicos. Use apenas coordenadas do jogo e IDs de teste. Há limites básicos de tamanho/frequência; isso não substitui segurança.

## O que o Mirror v2.2.0 original faz

O addon enviado pelo usuário usa `p.location` com coordenadas decimais, `p.getRotation()` (yaw/pitch), `isSneaking`, `isSprinting`, `isJumping`, `isOnGround`, diferenças entre ticks, item da mão e eventos `entityHitEntity`, `entityHurt`, `playerBreakBlock` e `playerPlaceBlock`. Ele calcula a reflexão `x'=1-x-0.0000001`, `z'=1-z-0.0000001` e `yaw'=yaw+180` **dentro do addon**.

Esta API Beta suporta o transporte desses tipos de campo **quando transmitidos**. O `querytarget @a` atual do BDS fornece principalmente `uniqueId`, `id`, `dimension`, `position` e `yRot`; ele **não fornece automaticamente** todos os sinalizadores de salto, item e interação. Será necessário melhorar o transmissor para esses dados mais tarde.

## Endereços

Base Render: `https://bubble-api-8dyc.onrender.com`

| Método | Rota | Uso |
|---|---|---|
| GET | `/` | Status básico, nome e caminhos |
| GET | `/healthz` e `/beta/healthz` | Disponibilidade, contadores de envio e salas |
| GET | `/beta/schema` | Formato dos dados |
| GET | `/beta/rooms` | Lista de salas com dados vivos |
| GET | `/beta/players?room=bubble-N001z` | Todos os últimos estados da sala |
| POST | `/beta/state` | Publica um estado bruto de um jogador |
| POST | `/beta/publish` | Alias de `/beta/state` |
| POST | `/beta/state/batch` | Até 32 jogadores por chamada |
| POST | `/beta/events` | Publica evento bruto pontual (ataque, bloco etc.) |
| WS | `/beta/live` | WebSocket de envio/recepção, **sem autenticação** |
| WS | `/v2/live` | Alias temporário para o app Android antigo |
| GET | `/v2/healthz` | Alias temporário de diagnóstico |

As outras rotas `/v1` e `/v2` antigas deixam de existir após a instalação do Beta. Faça backup do repositório primeiro. O instalador mantém arquivos antigos não utilizados para facilitar reversão.

## Exemplo de publicação HTTP

```bash
curl -sS -X POST 'https://bubble-api-8dyc.onrender.com/beta/state' \
  -H 'Content-Type: application/json' \
  -d '{"room":"bubble-N001z","serverId":"bds-teste","playerId":"steve","name":"Steve","state":{"dimension":1000,"position":{"x":1.920806288719177,"y":68.62001037597656,"z":-1.804710984230042},"yRot":50.5970458984375}}'
```

Consultar:

```bash
curl -sS 'https://bubble-api-8dyc.onrender.com/beta/players?room=bubble-N001z'
```

OBS: a posição expira em 3 segundos. Para testar com calma, execute o emissor de demonstração incluído (`node tools/demo-sender.js`) que envia estados continuamente.

## Exemplo de WebSocket

Cliente conecta em `wss://bubble-api-8dyc.onrender.com/beta/live`.

Não precisa enviar chave ou token. A API manda `hello`, `ready`, `snapshot`. Opcionalmente, cliente escolhe outra sala:

```json
{"type":"subscribe","room":"bubble-N001z"}
```

Para publicar:

```json
{"type":"publish","room":"bubble-N001z","serverId":"bds-teste","playerId":"steve","state":{"dimension":1000,"position":{"x":1.25,"y":65,"z":-2.75},"yRot":45,"pitch":-12,"flags":{"isSneaking":false,"isSprinting":true,"isJumping":false}}}
```

A API manda `ack` ao emissor e `state` a todos os inscritos (inclusive ao próprio emissor, útil para 1 celular):

```json
{"type":"state","room":"bubble-N001z","instanceId":"bubble-N001z","serverId":"bds-teste","bdsId":"bds-teste","playerId":"steve","name":null,"state":{"dimension":1000,"position":{"x":1.25,"y":65,"z":-2.75},"yRot":45,"pitch":-12,"flags":{"isSneaking":false,"isSprinting":true,"isJumping":false}},"updatedAt":1234567890,"revision":1}
```

O addon futuro recebe **essas coordenadas reais intactas** e então decide aplicar espelho, interpolação, movimento, salto, cabeça e animações.

### Eventos pontuais

```json
{"type":"event","room":"bubble-N001z","serverId":"bds-teste","playerId":"steve","event":{"type":"block_break","x":2,"y":65,"z":3,"block":"minecraft:stone"}}
```

O receptor decide se quebra o bloco espelhado; a API apenas retransmite o evento.

## Compatibilidade temporária com o BubbleBDSHost atual

O `BubbleApiStream.java` atual envia via `wss://.../v2/live`, faz `{"type":"auth","token":"...","instanceId":"..."}` e envia `type=publish` com `bdsId`, `playerId` e `state`. A Beta **aceita essa mensagem e ignora o token por completo**. Assim, o protocolo antigo do transmissor continua aceito.

**Limite importante:** o aplicativo atual ainda depende de Firebase para descobrir o manifesto, a dimensão, o BDS UID e a associação dos membros **antes de publicar**. A API Beta não precisa de Firebase, mas isso não remove automaticamente o Firebase do APK. No passo seguinte será preciso simplificar o app para capturar `querytarget` e publicar mesmo sem Firebase. O antigo receptor `BubbleAddonViewerBridge` que pede `/v2/access/grant` também deve ser retirado do app quando fizermos essa integração; a Beta não gera esses tokens.

## Teste no computador ou Termux

```bash
npm install
npm test
npm start
```

Em outro shell:

```bash
curl http://localhost:3000/healthz
node tools/demo-sender.js http://localhost:3000
```

Em outro terminal, ver os pacotes via WebSocket (Node 22):

```bash
node tools/demo-viewer.js ws://localhost:3000 bubble-N001z
```

## Publicar no Render

No Termux use o instalador da raiz do ZIP, depois `npm install`, `npm test`, e **adicione só os arquivos do patch** ao Git com `git add package.json package-lock.json render.yaml README.md .gitignore src/server.js src/beta-core.js test/beta.test.js tools/demo-sender.js`. Em seguida `git commit` e `git push`. Nunca use `git add -A` neste repositório sem checar segredos e backups. O arquivo `render.yaml` novo usa o mesmo nome de serviço, mas um serviço Render criado previamente pode manter o `Build Command` antigo na UI; `yarn install` também instala a única dependência `ws`.

Configurações padrão: porta de `PORT`, sala `bubble-N001z`, TTL 3000 ms, até 64 jogadores por sala, até 8 salas e 30 atualizações/segundo por jogador. Não há banco de dados. Ao reiniciar, a RAM é zerada; quando não chegam novas posições, desaparecem automaticamente após 3s.
