# Conteúdos Exclusivos para Apoiadores (Early Access / Dev Channel)

Guia oficial de arquitetura e publicação de pacotes experimentais/visuais exclusivos para apoiadores (`wowlk_site.donation` / `devwowlk`), totalmente isolados das atualizações padrão do jogo.

---

## 1. Garantia de Isolamento (Zero Impacto em Jogadores Comuns)

| Canal | Manifesto no Servidor (`/mnt/500gb/app/manifests/`) | Prefixo no Cloudflare R2 (`olk-client`) | Quem acessa |
|---|---|---|---|
| **Padrão 32-bit** | `wow32.json` | `patches/vX.Y.Z/...` | Todos os jogadores |
| **Padrão 64-bit** *(futuro)* | `wow64.json` | `patches/wow64/vX.Y.Z/...` | Todos os jogadores |
| **Apoiador / Dev 32-bit** | `dev/wow32-dev.json` | `supporter/wow32/vX.Y.Z/...` | **Somente apoiadores com toggle ON** |
| **Apoiador / Dev 64-bit** *(futuro)* | `dev/wow64-dev.json` | `supporter/wow64/vX.Y.Z/...` | **Somente apoiadores com toggle ON** |

### Regras de ouro:
1. **Nunca misturar 32-bit com 64-bit:** cada cliente tem seu próprio arquivo em `manifests/dev/<client>-dev.json` (`wow32-dev.json` vs `wow64-dev.json`). Um patch de 32-bit nunca é baixado ou aplicado no 64-bit e vice-versa.
2. **Nunca tocar nos manifestos padrão:** publicar um conteúdo de teste para apoiadores **jamais** edita `wow32.json`, `wow64.json` ou `launcher.json`.
3. **Verificação no servidor (Pikachu):** a rota `GET /launcher/v1/manifest/{client}/supporter` exige Bearer token válido **e** consulta `wowlk_site.donation` em tempo real. Contas não-apoiadoras recebem HTTP `403`.
4. **Overlay 100% reversível no cliente:**
   - Os arquivos exclusivos ficam em cache dentro de `<pasta-do-jogo>/.olk-supporter/files/`.
   - **Toggle LIGADO:** antes de abrir o jogo (ou ao sincronizar), o launcher aplica os arquivos na pasta do jogo, fazendo backup automático em `.olk-supporter/backups/` caso algum arquivo base seja substituído.
   - **Toggle DESLIGADO (ou logout):** o launcher remove imediatamente os arquivos exclusivos da pasta do jogo e restaura qualquer backup original, deixando o cliente **100% idêntico ao de um jogador comum**. O cache em `.olk-supporter/files/` é mantido para religar instantaneamente sem baixar tudo de novo.
   - **Atualizações normais do jogo (`wow32.json`):** antes de rodar `Update` ou `Repair`, o launcher desativa o overlay temporariamente, aplica o patch oficial na base limpa e só então reativa o overlay se o toggle estiver ligado.

---

## 2. Formato do Manifesto (`wow32-dev.json` / `wow64-dev.json`)

O schema é o mesmo `schema_version: 1` validado pelo `ManifestService.cjs` (SHA-256 obrigatório, caminhos relativos seguros, bloqueio de `WTF/Account`, `Screenshots` e `.olk*`):

```json
{
  "schema_version": 1,
  "client": "wow32",
  "architecture": "x86",
  "version": "0.1.0-dev.1",
  "published_at": "2026-11-22T20:00:00Z",
  "files": [
    {
      "path": "Data/patch-S.MPQ",
      "size": 12345678,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "url": "https://pub-aca87790200a4237af40519010e23d8c.r2.dev/supporter/wow32/v0.1.0-dev.1/Data/patch-S.MPQ"
    }
  ],
  "deleted_files": []
}
```

### Campos obrigatórios:
- `schema_version`: sempre `1`.
- `client`: `"wow32"` para o cliente 32-bit ou `"wow64"` para o futuro cliente 64-bit.
- `architecture`: `"x86"` (para `wow32`) ou `"x64"` (para `wow64`).
- `version`: SemVer válido (ex.: `"0.1.0"`, `"0.1.1"`, `"0.2.0-dev.1"`). Sempre incrementar quando publicar mudança.
- `files`: lista completa de arquivos que compõem o pacote exclusivo atual.
  - `path`: caminho relativo à raiz da pasta do jogo (ex.: `Data/patch-S.MPQ`, `ReShadePreset.ini`, `Interface/AddOns/...`).
  - `size`: tamanho exato em bytes.
  - `sha256`: hash SHA-256 em hex minúsculo (64 caracteres).
  - `url`: URL HTTPS direta e imutável no Cloudflare R2 (`https://pub-aca87790200a4237af40519010e23d8c.r2.dev/supporter/<client>/v<version>/<path>`).
- `deleted_files`: manter `[]` (a remoção de arquivos antigos do pacote exclusivo é automática quando um arquivo deixa de aparecer em `files`).

---

## 3. Boas Práticas para Patches Visuais (WoW 3.3.5a — `wow32`)

- **Use uma letra de MPQ dedicada** que não conflite com os patches padrão do servidor (ex.: `Data/patch-S.MPQ` ou `Data/patch-Y.MPQ` — verifique quais `Data/patch-*.MPQ` já existem em `wow32.json` antes de escolher!).
- **Não altere `realmlist.wtf` nem `WTF/Account/**`** pelo manifesto dev (essas pastas são protegidas).
- **Prefira melhorias visuais / cosméticas / client-side** (texturas HD, efeitos, iluminação, presets gráficos, interface) que não exijam mudanças incompatíveis no protocolo do servidor, garantindo que jogadores com toggle ON e OFF joguem juntos no mesmo reino sem erros.
- **Para o futuro cliente 64-bit (`wow64`):** publique apenas em `/mnt/500gb/app/manifests/dev/wow64-dev.json` com `"client": "wow64"` e `"architecture": "x64"`, usando prefixo R2 `supporter/wow64/v<version>/...`.

---

## 4. Passo a Passo para Publicar um Novo Pacote Dev (32-bit)

No servidor (`soder@server`):

1. **Suba os arquivos para o Cloudflare R2** sob `supporter/wow32/v<VERSAO>/`:
   ```bash
   /home/soder/.venv/bin/python /mnt/1tb/soder-wow-server/upload_r2.py \
     /caminho/local/patch-S.MPQ \
     supporter/wow32/v0.1.0/Data/patch-S.MPQ
   ```

2. **Calcule tamanho e SHA-256:**
   ```bash
   stat -c%s /caminho/local/patch-S.MPQ
   sha256sum /caminho/local/patch-S.MPQ
   ```

3. **Crie/atualize o manifesto atomicamente** em `/mnt/500gb/app/manifests/dev/wow32-dev.json`:
   ```bash
   mkdir -p /mnt/500gb/app/manifests/dev
   # Escreva em .tmp e mova com mv para substituição atômica:
   mv /mnt/500gb/app/manifests/dev/wow32-dev.json.tmp /mnt/500gb/app/manifests/dev/wow32-dev.json
   ```

4. **Valide o manifesto com o validador oficial do launcher:**
   ```bash
   node -e "const {validateManifest}=require('./electron/core/ManifestService.cjs');validateManifest(require('/mnt/500gb/app/manifests/dev/wow32-dev.json'),'wow32');console.log('OK')"
   ```

5. **Pronto!** Em até 2 minutos em standby (ou imediatamente ao ligar o toggle / clicar em Play), o launcher dos apoiadores com o toggle ligado detecta a nova versão, baixa no cache isolado e aplica automaticamente ao iniciar o jogo.

---

## 5. Como Remover / Fazer Rollback de um Pacote Dev

- **Rollback para versão anterior:** republique o `wow32-dev.json` apontando para os arquivos antigos no R2 com um número de `version` maior (ex.: `0.1.2`).
- **Remover completamente o pacote dev:** apague `/mnt/500gb/app/manifests/dev/wow32-dev.json` (a rota passa a responder `404` e o launcher desativa o overlay).
