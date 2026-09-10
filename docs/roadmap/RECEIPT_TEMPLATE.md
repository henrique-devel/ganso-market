# Recibo de bloco — modelo

Copiar ao concluir para `docs/roadmap/receipts/<ID>.md`; máximo recomendado: 25 linhas.
Não preencher resultados previstos como se fossem observados.

```text
Bloco: <ID> | RFC: <ID> | Data UTC: <instante>
Estado: pending / in-progress / code-verified / production-verified / blocked / superseded
Código: <SHA/base + mudanças ainda não commitadas, se houver>
Resultado: <uma frase do que agora funciona ou do que foi medido>
Arquivos: <lista curta>
Dependências verificadas: <ID + recibo/código efetivamente conferido>
Contratos/versões: <schema/config/modelo/policy relevantes>
Testes: <comando, resultado, contagem e ambiente reais>
Aceite: <evidência do comportamento, não apenas nome da suíte>
Produção: <não consultada / consulta datada / release por serviço afetado>
Dados: <dataset/manifests/pins e prova de integridade, quando aplicável>
Limites: <não verificado, dado faltante, hipótese ou risco residual>
Autorização operacional: <referência ao escopo, se ocorreu escrita>
Próximo bloco elegível: <ID e dependência restante>
```

`code-verified` não equivale a deploy nem a aceite de soak; se o bloco é documental,
descreva “especificação verificada” no resultado, sem atribuir efeito ao runtime.
