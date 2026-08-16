# Runbook — perímetro de autenticação (RFC-002)

Este runbook cobre o que precisa existir **fora do código** antes de publicar o
login/tokens da RFC-002 no servidor standalone. O código de autenticação já está
implementado e testado; expor o painel autenticado no IP público é uma decisão
operacional do proprietário.

## Modelo de perímetro

O bootstrap standalone publica somente o Nginx. Enquanto o painel servia apenas
health público, o PRD aceitou `0.0.0.0:80` sem firewall gerenciado pelo projeto.
**Ao publicar login, tokens e dados privados, esse perímetro precisa ser
restringido.** Duas opções aceitas:

1. **HTTP + Hetzner Cloud Firewall (modelo da RFC-002):** manter HTTP na porta 80,
   mas restringir a porta ao IP público do operador via firewall da Hetzner (fora
   do Compose). Aceita o risco de HTTP em claro porque há um único operador, o IP
   é restrito e a burn/hot wallet tem saldo limitado.
2. **TLS:** adotar HTTPS (domínio + certificado). Ao fazê-lo, ligar o flag
   `Secure` dos cookies (hoje desligado enquanto o beta é HTTP — ver
   `apps/api/src/auth/cookies.ts` e `PRD` AUTH-07).

Enquanto (1) ou (2) não estiver em vigor, **não** publicar o painel autenticado
para qualquer origem. O código não implementa contorno de geoblock nem abre HTTP
para o mundo por conta própria; a restrição é responsabilidade do operador.

## Regra de firewall Hetzner (opção 1)

No painel/API da Hetzner Cloud Firewall do servidor:

- **Inbound TCP 80**: source `SEU_IP_PUBLICO/32` apenas. Sem regra IPv6 para a
  porta 80 (a aplicação não publica listener IPv6).
- **Inbound TCP 22 (SSH)**: conforme a regra administrativa já existente.
- **Negar** todo o resto de entrada da aplicação.

Ao trocar de IP, atualizar a regra `TCP 80 source`. Verificação manual: de uma
origem permitida o login carrega; de outra origem a conexão na porta 80 não é
estabelecida.

## Conta única

A conta é criada/rotacionada localmente, nunca por endpoint público:

```bash
# dentro do container da API (a senha vem do stdin, nunca de argv)
printf '%s' 'SENHA-COM-16-OU-MAIS-CARACTERES' | \
  docker compose exec -T api node dist/account-cli.js create owner

# rotacionar a senha (revoga todas as sessões):
printf '%s' 'NOVA-SENHA-FORTE' | \
  docker compose exec -T api node dist/account-cli.js reset owner
```

A CLI recusa senha com menos de 16 caracteres e nunca imprime o valor.

## Invariantes verificáveis

- Nenhum endpoint público de cadastro; a conta só é criada/rotacionada por CLI.
- Só hashes de senha (Argon2id) e de tokens (SHA-256) são persistidos.
- Access token expira em ≤15 min; refresh em ≤7 dias, rotacionado a cada uso;
  reuso revoga a família e a sessão.
- Cookies `HttpOnly`/`SameSite=Strict` com `Path=/api/auth`; `Secure` só com TLS.
- Requests mutáveis exigem Origin == Host e CSRF (double-submit) em refresh/logout.
- O gateway rejeita Host inesperado (`default_server` → 444) e aplica CSP,
  `X-Content-Type-Options`, política de frame/referrer e rate limit no login.
