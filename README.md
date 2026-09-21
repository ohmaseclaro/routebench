# routebench

Um benchmark honesto de um solver de CVRP escrito do zero contra os dois baselines de
código aberto mais usados: **VROOM** e **OR-Tools**.

O solver é uma implementação do SISR (Christiaens & Vanden Berghe, 2020), escrita a
partir do paper.

## Resultado

Instâncias do conjunto X do CVRPLIB (Uchoa et al.), com ótimos publicados. Cada solver
recebe o **mesmo wall clock** — VROOM não tem limite de tempo, então ele roda primeiro e
o tempo que levou vira o orçamento dos outros dois. Gap em relação à melhor solução
conhecida, menor é melhor.

| instância | n | clientes/rota | orçamento | VROOM | OR-Tools | este solver (min/média de 3 sementes) |
|---|---|---|---|---|---|---|
| X-n101-k25 | 101 | 3,8 | 30 s | **0,50 %** | 5,30 % | 1,02 / 1,43 % |
| X-n214-k11 | 214 | 17,8 | 30 s | **3,17 %** | 13,07 % | 9,76 / 10,83 % |
| X-n420-k130 | 420 | 3,2 | 32 s | 1,74 % | 4,70 % | **1,42 / 1,62 %** |
| X-n716-k35 | 716 | 20,4 | 115 s | **2,79 %** | 8,00 % | 8,46 / 9,91 % |
| X-n1001-k43 | 1001 | 23,3 | 282 s | **2,95 %** | 10,09 % | 15,84 / 16,57 % |

25 execuções, nenhuma solução inválida.

**VROOM vence em 4 das 5 instâncias**, com margem que cresce junto com o tamanho da
rota. Ele é C++, licença BSD, gratuito e maduro. OR-Tools perde em todas — quem usar o
OR-Tools como referência de "estado da arte" vai tirar a conclusão errada.

## O que deu certo, e o que não deu

**A engenharia de memória funciona.** A taxa de iterações quase não cai com o tamanho do
problema: 99 000 it/s com n = 101 e 66 000 it/s com n = 1001, para dez vezes mais
clientes. Matriz de distâncias como `Int32Array` plana, listas de vizinhos planas, custo
e carga mantidos incrementalmente por rota, e um undo log que desfaz uma iteração
rejeitada restaurando só as rotas que ela mexeu.

**A qualidade da busca não acompanha, e não é falta de tempo.** Com n = 1001 são 19
milhões de iterações e o gap ainda fica em 16 %. Três explicações foram testadas e
descartadas:

| hipótese | teste | resultado |
|---|---|---|
| ordem interna das rotas ruim | 2-opt intra-rota em toda rota alterada | 10,2 % → 11,4 %, sem ganho |
| veículos demais | contagem comparada com VROOM | idêntica nas 5 instâncias |
| temperatura descalibrada | varredura de t0 de 30 a 3000 com n = 1001 | 12,3 % a 17,9 %, nada perto de 2,95 % |

O gap acompanha **clientes por rota**, não o tamanho da instância: 1,4 % com rotas de
3–4 clientes, 10–16 % com rotas de 18–23. A causa é estrutural na implementação e é
justamente o que anos de refinamento do VROOM já resolveram.

## Conclusão

Velocidade não é o problema: a taxa de iterações escala bem. O que falta é qualidade de
busca em rotas longas, e é aí que está a distância até o VROOM.

## Metodologia

O que torna estes números confiáveis:

- **Uma única função de custo.** Nenhum solver é pontuado pelo objetivo que ele mesmo
  reporta. Cada um devolve rotas e `src/validate.py` recalcula tudo com a mesma função,
  recusando solução com cliente repetido, cliente faltando, rota acima da capacidade ou
  depósito no meio do percurso.
- **A função de custo foi verificada contra a literatura.** Ela reproduz exatamente o
  custo publicado da melhor solução conhecida de X-n101-k25 (27591) a partir do arquivo
  `.sol` — arredondamento euclidiano incluído, que faz parte da definição do problema.
- **Mesmo wall clock para todos**, ditado pelo VROOM.
- **Invariantes do solver testadas.** `src/sisr.test.ts` roda a busca real com
  verificação ligada, conferindo o bookkeeping incremental contra um recálculo do zero a
  cada 32 iterações. Ele pegou dois bugs reais durante o desenvolvimento: um rollback que
  duplicava clientes e um índice cliente→rota apontando para uma rota já descartada.
  Ambos produziriam números melhores e errados.

Uma limitação assumida: o resfriamento é guiado por tempo decorrido, não por contagem de
iterações, então duas execuções com a mesma semente não são idênticas. A variação entre
execuções (~1 ponto percentual) é maior que a diferença entre boa parte dos parâmetros,
o que limita quanto dá para afinar honestamente. Trocar para resfriamento por iteração
tornaria o solver reprodutível, ao custo de não respeitar mais um orçamento de tempo
fixo — que é a comparação que interessa aqui.

## Reproduzindo

```bash
python3 -m venv .venv && ./.venv/bin/pip install ortools
docker pull ghcr.io/vroom-project/vroom-docker:v1.14.0
```

```bash
node --experimental-strip-types src/sisr.test.ts instances/cvrp/X-n101-k25.vrp
```

```bash
MIN_BUDGET=30 SEEDS="1 2 3" ./scripts/bench.sh results/bench.jsonl instances/cvrp/X-n101-k25.vrp
```

| arquivo | o que é |
|---|---|
| `src/sisr.ts` | o solver: ruin-and-recreate por remoção de strings |
| `src/sisr.test.ts` | teste de invariantes do bookkeeping incremental |
| `src/cvrplib.py` | leitura das instâncias, função de custo, validador |
| `src/validate.py` | pontua as rotas de qualquer solver |
| `src/run_ortools.py`, `src/run_vroom.py`, `src/run_sisr.ts` | os três runners |
| `scripts/bench.sh`, `scripts/sweep.sh` | benchmark e varredura de parâmetros |

Instâncias: [CVRPLIB](http://vrp.galgos.inf.puc-rio.br/), conjunto X de Uchoa et al.
(2017), via o repositório [PyVRP/Instances](https://github.com/PyVRP/Instances).
