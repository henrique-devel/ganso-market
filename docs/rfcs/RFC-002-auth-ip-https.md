# RFC-002 — Autenticação e HTTPS por IP

**Status:** draft  
**Dependências:** RFC-001  
**Bloqueia:** acesso beta pela internet  

## Prompt a executar

Você deve implementar a RFC-002 do Ganso Market: autenticação single-user e HTTPS confiável diretamente pelo IP público.

### Objetivo

Entregar um painel acessível por `https://<IP_DO_SERVIDOR>`, sem domínio, protegido por usuário/senha, access token e refresh token. Não implementar MFA, passkey, cadastro público ou recuperação por e-mail.

### Fatos verificados

- O Let’s Encrypt oferece certificados públicos para IPv4/IPv6.
- Certificados de IP usam perfil short-lived e valem aproximadamente 160 horas.
- Certbot 5.4+ suporta emissão por IP em modo webroot.
- Certbot ainda exige configurar o proxy para carregar os arquivos emitidos.

Fontes:

- https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html
- https://letsencrypt.org/2026/03/11/shorter-certs-certbot

### Restrições

- Uma conta apenas.
- Sem endpoint de signup.
- Sem OAuth, e-mail, MFA, passkey ou CAPTCHA.
- Não usar token em `localStorage`.
- Não armazenar token em texto puro no banco.
- Não usar certificado self-signed no ambiente beta público.
- Não expor signer, PostgreSQL, métricas internas ou debug.
- Não registrar senha, token, cookie ou Authorization header.
- Não presumir que o IP do servidor é conhecido durante build; ele é configuração validada no deploy.

### Tarefas de autenticação

1. Criar CLI local para criar/resetar a conta única.
2. Exigir senha mínima de 16 caracteres.
3. Armazenar senha com Argon2id calibrado para aproximadamente 250–500 ms no CPX42.
4. Implementar access token:
   - opaco;
   - 256 bits aleatórios ou mais;
   - hash armazenado no servidor;
   - validade máxima de 15 minutos;
   - enviado no header Authorization;
   - mantido apenas em memória no frontend.
5. Implementar refresh token:
   - opaco;
   - validade máxima de sete dias;
   - cookie `HttpOnly`, `Secure`, `SameSite=Strict`;
   - rotação em toda utilização;
   - somente hash no banco;
   - detecção de reutilização.
6. Reutilização de refresh antigo revoga toda a família de sessão.
7. Logout, troca/reset local de senha e comando de emergência revogam sessões.
8. Implementar atraso progressivo e bloqueio temporário após falhas.
9. Validar `Origin`, `Host` e CSRF em requests mutáveis baseadas em cookie.
10. Garantir mensagens de login que não revelem se usuário existe.
11. Criar audit events para login, falha, refresh, reutilização, logout e reset, sem dados sensíveis.

### Tarefas de rede/TLS

1. Configurar Nginx como único entrypoint público.
2. Porta 80:
   - servir `/.well-known/acme-challenge/`;
   - redirecionar restante para HTTPS.
3. Porta 443:
   - certificado contendo o IP;
   - TLS 1.2+;
   - proxy apenas para frontend/API necessários.
4. Automatizar emissão e renovação usando Certbot 5.4+:
   - perfil `shortlived`;
   - `--ip-address <IP>`;
   - webroot;
   - timer pelo menos duas vezes ao dia;
   - reload atômico do Nginx após sucesso.
5. Expor métrica e alerta visível no dashboard quando faltar menos de 48 horas para expiração.
6. Aplicar HSTS depois de validar emissão/renovação, CSP, frame policy, referrer policy e `X-Content-Type-Options`.
7. Aplicar limite de tamanho de body, timeouts e rate limit específico no login.
8. Documentar firewall:
   - público: 80/443;
   - SSH conforme administração do proprietário;
   - nenhum outro serviço da aplicação.

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
- Configuração Nginx.
- Automação Certbot e renovação.
- Security headers.
- Audit events.
- Runbook de primeira emissão, renovação e recuperação.
- Testes.

### Testes obrigatórios

- Senha correta/incorreta.
- Lock temporário e retorno depois da janela.
- Access expirado.
- Refresh válido, rotacionado, expirado e reutilizado.
- Logout revoga os dois tokens.
- Reset local revoga todas as sessões.
- CSRF, Origin e Host inválidos.
- Cookies possuem flags corretas.
- Headers/logs não vazam tokens.
- Rota privada retorna 401 sem sessão.
- Nginx não encaminha Host/IP inesperado.
- Teste da emissão primeiro em staging ACME.
- Teste automatizado valida SAN do certificado, cadeia pública e data de expiração.
- Simulação de falha de renovação produz alerta antes da expiração.

### Critérios de aceite

- Navegador comum abre o IP sem alerta TLS.
- Apenas a conta única pode entrar.
- Access token dura no máximo 15 minutos.
- Refresh rotaciona e reutilização revoga a sessão.
- Certificado é renovado sem intervenção manual.
- Nenhuma porta interna fica pública.
- Não há código de MFA/passkey/signup.

### Condições de parada

Pare se:

- o IP não for estático ou não estiver sob controle do operador;
- portas 80/443 não puderem receber o desafio ACME;
- o cliente ACME instalado não suportar certificado de IP short-lived;
- o ambiente exigir certificado autoassinado para o beta público;
- tokens ou senha aparecerem em logs;
- algum serviço interno precisar ser exposto para “facilitar” a implantação.
