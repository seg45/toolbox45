# Templates de importação de comandos

Planilhas `.csv` prontas para importar comandos no Toolbox45 via
**Configurações → Cadastro → Import commands**. Cada arquivo cobre um
fabricante e serve tanto de exemplo (comandos reais, prontos para importar)
quanto de ponto de partida para quem quiser adaptar/estender.

## Arquivos atuais

| Arquivo | Fabricante | Comandos |
|---|---|---|
| `check-point.csv` | Check Point (Gaia) | 8 — status de processos, captura, debug de drops, versão/hotfixes, tabela de conexões, rotas, SecureXL, licenças |
| `fortinet.csv` | Fortinet (FortiOS) | 8 — status geral, sniffer, debug flow, CPU/memória/sessões, memória de hardware, tabela de sessões, rotas, FortiGuard |

Descrição e detalhes (finalidade, quando usar e notas) estão em português;
comandos e prompts ficam no formato técnico original (não são traduzidos).

## Formato

Mesmas colunas usadas pelo botão "Import commands" da aplicação (baixe o
template de lá — `Configurações → Cadastro → Import commands → Download
template` — para conferir a lista atual e um exemplo preenchido):

```
Name;Description;Vendor;System;Topics;Versions;Environments;Prompt;Command;Note;Details
```

- `Details` substitui as antigas colunas separadas Purpose/When to use/Notes
  — é um campo único de rich text (mesmo editor de formatação usado em Notes
  da pasta Folders). Nestes templates .csv, o conteúdo de cada linha já vem
  em HTML simples (`<p>`/`<strong>`), mas texto puro também funciona.

- Sem coluna de ID — é um detalhe interno, sempre gerado automaticamente a
  partir do `Name` (igual ao editor manual de comandos).
- Delimitador `;` (não vírgula), arquivo em UTF-8 com BOM.
- `Vendor` aceita **um único** valor. `System`, `Topics`, `Versions` e
  `Environments` aceitam vários, separados por vírgula.
- `Command` pode ter várias linhas dentro da mesma célula (célula entre
  aspas, uma linha de comando por linha de texto) — todas usam o mesmo
  `Prompt`.
- Tokens como `{{ip}}`, `{{src_ip}}`, `{{port}}` etc. (ver catálogo de
  Parâmetros em Configurações → Cadastro) podem ser usados dentro de
  `Command` — a aplicação substitui pelo valor digitado na barra de busca.

## Pré-requisito importante: o catálogo

`Vendor`, `System`, `Topics`, `Versions` e `Environments` **precisam já
existir no catálogo da instância onde o arquivo for importado**
(Configurações → Cadastro → Manage → Vendors/Systems/Versions/Environments/
Topics). Se algum valor não existir:

- Vendor/System/Versions/Environments/Topics vazios ou totalmente
  desconhecidos → a linha inteira é rejeitada (nenhum comando é criado).
- Numa célula com vários valores (ex.: Topics), os que não existirem são só
  ignorados com aviso, desde que pelo menos um valor da célula seja
  reconhecido.

Os catálogos usados aqui (Check Point/Gaia e Fortinet/FortiOS, com as
versões e o ambiente "Standalone") já existem no banco principal do projeto
no momento em que estes arquivos foram criados — mas numa instância nova
("do zero"), cadastre Vendor → System → Versions → Environments → Topics
antes de importar.

## Adicionando um novo fabricante

1. Crie `import-templates/<fabricante>.csv` (nome do arquivo em minúsculas,
   sem espaços — ex.: `paloalto.csv`, `fortinet.csv`).
2. Use comandos reais e verificados, cobrindo os tópicos já existentes no
   catálogo sempre que fizer sentido (reaproveitar tópicos genéricos como
   Status/System/Routing/Licenses evita ter que cadastrar tópicos novos só
   para o template funcionar de primeira).
3. Descrição/Finalidade/Quando usar/Notas em português; comando/prompt no
   formato técnico nativo do fabricante.
4. Valide antes de commitar: baixe o template oficial da aplicação para
   comparar cabeçalho, e confira se os valores de Vendor/System/Topics/
   Versions/Environments usados no arquivo batem com o catálogo (ou deixe
   claro no PR/commit quais itens precisam ser cadastrados antes de
   importar).
5. Atualize a tabela acima.
