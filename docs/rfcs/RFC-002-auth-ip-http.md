# RFC-002 — Autenticação e HTTP por IP restrito

**Status:** implementada (2026-08-15); publicada em produção sob firewall Hetzner em 2026-08-18

O código de autenticação single-user, os tokens rotativos, o endurecimento do
gateway e a CLI de conta estão implementados e verificados
([`docs/test-results/RFC-002.md`](../test-results/RFC-002.md)). O painel autenticado
está publicado sob a regra de firewall (allowlist de IP na Hetzner) descrita em [`docs/runbooks/auth-perimeter.md`](../runbooks/auth-perimeter.md) —
o código não abre HTTP para o mundo por conta própria. O modelo de perímetro
abaixo (HTTP + allowlist de IP na Hetzner) permanece válido.

**Dependências:** RFC-001 implementada

**Bloqueia:** acesso beta pelo servidor

## Prompt a executar

Você deve implementar a RFC-002 do Ganso Market: autenticação single-user e acesso simples por IP.

### Objetivo

Entregar o painel em `http://178.105.65.251/`, sem domínio, certificado, Certbot ou porta 443. A porta 80 deve aceitar tráfego somente do IP público do operador por regra no firewall da Hetzner.

### Decisão de perímetro

- Entrada da aplicação: HTTP na porta 80.
- URL: `http://178.105.65.251/`.
- Única origem permitida no firewall: `<IP_PUBLICO_DO_OPERADOR>/32`.
- A aplicação não publica IPv6; não existe bind `[::]:80` nem regra TCP/80 IPv6.
- Nginx é o único processo publicado.
- API, frontend e WebSocket usam a mesma origem.
- PostgreSQL, market-engine, model-worker, signer e métricas permanecem em redes internas.
- Não implementar HTTPS, ACME, certificado, domínio, Caddy ou porta 443 no MVP.
- Se não for possível limitar a porta 80 ao IP do operador, pare: nesse caso HTTP não é aceitável e será necessário voltar para HTTPS ou túnel privado.

### Risco aceito

HTTP não criptografa senha, access token, refresh token ou dados do painel. A allowlist impede conexões de outras origens, mas não protege contra um atacante que consiga observar ou alterar o tráfego entre o navegador e o servidor.

Esse risco é aceito somente porque:

- existe um único operador;
- a porta 80 é limitada ao IP do operador;
- o sistema é pessoal;
- o saldo da hot wallet é deliberadamente limitado.

Não descreva HTTP como seguro; descreva-o como simplificação consciente do beta.

### Restrições

- Uma conta apenas.
- Sem signup, OAuth, e-mail, MFA, passkey ou CAPTCHA.
- Não armazenar tokens em texto puro no banco.
- Não registrar senha, token, cookie ou Authorization header.
- Não expor endpoints de debug ou infraestrutura.
- Não permitir CORS cross-origin.
- Não aceitar Host arbitrário.
- Não usar `Secure` no cookie enquanto o acesso for HTTP; documentar que a flag volta a ser obrigatória se HTTPS for adotado.

### Tarefas de autenticação

1. Criar CLI local para criar/resetar a conta única.
2. Exigir senha mínima de 16 caracteres.
3. Armazenar senha com Argon2id calibrado para aproximadamente 250–500 ms no CPX42.
4. Implementar access token:
   - opaco;
   - pelo menos 256 bits aleatórios;
   - somente hash no banco;
   - validade máxima de 15 minutos;
   - header Authorization;
   - somente memória no frontend.
5. Implementar refresh token:
   - opaco;
   - validade máxima de sete dias;
   - cookie `HttpOnly` e `SameSite=Strict`;
   - sem `Secure` exclusivamente enquanto estiver em HTTP;
   - rotação a cada uso;
   - somente hash no banco;
   - detecção de reutilização.
6. Reutilização de refresh antigo revoga toda a família.
7. Logout, reset local de senha e comando de emergência revogam sessões.
8. Aplicar atraso progressivo e bloqueio temporário após falhas.
9. Validar CSRF, `Origin` e `Host` em requests mutáveis.
10. Não revelar se o usuário existe.
11. Registrar audit events sem informações sensíveis.

### Tarefas de rede

1. Publicar Nginx em `0.0.0.0:80` somente no profile/deploy beta, com bind explicitamente IPv4 e sem `[::]:80`.
2. Manter o bind local `127.0.0.1:8080` para desenvolvimento.
3. Configurar `server_name 178.105.65.251`.
4. Rejeitar Host diferente no default server.
5. Encaminhar:
   - `/api/*` para API;
   - `/ws` quando existir;
   - restante para frontend.
6. Aplicar CSP, frame policy, referrer policy e `X-Content-Type-Options`.
7. Aplicar body limit, timeouts e rate limit no login.
8. Não publicar 443.
9. Criar runbook manual da Hetzner Firewall:
   - TCP 80 source `<IP_PUBLICO_DO_OPERADOR>/32`;
   - nenhuma regra TCP 80 para IPv6;
   - TCP 22 conforme regra administrativa existente;
   - negar demais entradas da aplicação.
10. Documentar atualização da allowlist quando o IP do operador mudar.
11. Criar check operacional que falha se a configuração registrada usar `0.0.0.0/0` ou `::/0` na porta 80.

### API mínima

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/session`
- nenhum signup;
- nenhum reset remoto.

### Artefatos

- Schema de usuário, sessão e refresh family.
- CLI local de criação/reset.
- Middleware de autenticação.
- Frontend de login/logout.
- Configuração Nginx para local e beta.
- Profile de deploy HTTP.
- Security headers e rate limit.
- Audit events.
- Runbook de firewall/acesso.
- Testes.

### Testes obrigatórios

- Senha correta/incorreta.
- Lock temporário.
- Access expirado.
- Refresh válido, rotacionado, expirado e reutilizado.
- Logout e reset revogam sessões.
- CSRF, Origin e Host inválidos.
- Cookie possui `HttpOnly` e `SameSite=Strict`; ausência de `Secure` é verificada e documentada apenas para HTTP.
- Logs/headers não vazam tokens.
- Rota privada responde 401.
- Nginx rejeita Host inesperado.
- Development continua em loopback.
- Profile beta publica somente porta 80.
- Profile beta não cria listener IPv6.
- Porta 443 não está publicada.
- Check de política rejeita firewall `0.0.0.0/0` e `::/0`.
- Verificação operacional a partir de uma origem permitida e outra não permitida.

### Critérios de aceite

- Operador abre `http://178.105.65.251/`.
- Origem allowlisted chega ao login.
- Origem fora da allowlist não estabelece conexão na porta 80.
- IPv6 não estabelece conexão na porta 80.
- Apenas a conta única entra.
- Access token expira em até 15 minutos.
- Refresh é rotacionado e reutilização revoga a sessão.
- Nenhuma porta interna ou 443 fica pública.
- Não há código de HTTPS/Certbot/MFA/passkey/signup.
- O painel exibe aviso discreto de “acesso HTTP restrito por firewall”.

### Condições de parada

Pare se:

- a porta 80 estiver aberta para qualquer origem IPv4 ou IPv6;
- o IP do operador não puder ser definido/atualizado no firewall;
- algum serviço interno precisar ser publicado;
- Host/CORS precisarem ser liberados globalmente;
- senha ou token aparecerem em logs;
- for solicitado remover a allowlist mantendo HTTP;
- uma futura decisão transformar o painel em acesso multiusuário ou público geral.
