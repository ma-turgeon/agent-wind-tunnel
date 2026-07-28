---
layout: default
title: Agent Wind Tunnel — Résumé exécutif
description: Résumé en français de la valeur, de la méthode et des limites.
---

# Agent Wind Tunnel — Résumé exécutif

Agent Wind Tunnel est un laboratoire local qui aide à répondre à une question
de conception:

> Parmi les architectures d’agents évaluées, laquelle est la plus simple tout
> en respectant les exigences déclarées de qualité, de fiabilité, de budget et
> d’autorité?

L’idée d’affaires est simple: chaque planificateur, réviseur, boucle de
correction et étape d’approbation ajoute des appels, du délai, de la
maintenance et une surface de risque. Ces composants ne devraient être retenus
que s’ils corrigent un échec mesuré.

![Du contrat de scénario à la sélection sous contraintes](assets/selection-pipeline.svg)

## Ce que fait la démonstration

Le laboratoire compare quatre familles d’architecture:

1. un agent direct;
2. une boucle bornée d’évaluation et de correction;
3. des révisions spécialisées en parallèle;
4. un graphe gouverné avec planification, révisions et frontière
   d’approbation.

Avant l’exécution, il valide la structure, les contrats, les limites de visite
et les capacités demandées. Pendant l’exécution, il consigne chaque nœud visité
et chaque transition choisie. Il élimine ensuite les candidats qui échouent à
une exigence obligatoire. La complexité ne sert à départager les candidats
qu’après ces contrôles.

La démonstration par défaut fonctionne sans compte de modèle. Elle produit un
ensemble d’artefacts vérifiables: JSON, journaux NDJSON, rapport Markdown,
rapport HTML et manifeste de hachage.

## Résultat de calibration

Les cas inclus sont **synthétiques et composites**. Ils ont été conçus pour
tester le comportement du laboratoire:

| Cas de calibration | Plus petite topologie canonique qui réussit les contrôles déclarés |
| --- | --- |
| Transformation déterministe simple | directe |
| Lacune dans une procédure d’exploitation | boucle |
| Révision multidisciplinaire d’une livraison | révision parallèle |
| Déploiement conséquent simulé | graphe gouverné |

Une étude d’ablation retire aussi certains composants du graphe gouverné afin
de vérifier lesquels sont nécessaires dans ce corpus. Dans ces données
synthétiques, la présentation, la synthèse par modèle et l’exécution
spéculative peuvent être retirées sans échec déclaré, tandis que la révision
du plan et la révision de sécurité demeurent nécessaires à certains cas.

## Essai réel borné

Un essai distinct a comparé seulement `direct` et `loop` sur un scénario
synthétique, avec une seule configuration d’un modèle OpenAI et trois
répétitions par candidat. Les six exécutions ont satisfait la grille locale
structurelle et lexicale. À qualité égale selon cette grille, `direct` a été
retenu parce qu’il était moins complexe. L’échantillon a totalisé neuf appels
au modèle, 12 019 jetons, aucune nouvelle tentative et une estimation de
0,08756 USD fondée sur une carte de prix.

La limite est essentielle: `semanticGrader: none`; les chaînes des cas de test
nommés ont été comptées, mais non exécutées; aucun candidat Graph Max n’a été
exécuté avec le modèle réel. Il ne s’agit ni d’un banc d’essai, ni d’une
généralisation, ni d’une preuve de production, d’économies ou de rendement
financier, ni d’une facture du fournisseur.
[Voir l’essai réel borné](https://ma-turgeon.github.io/agent-wind-tunnel/live-pilot.html).

## Ce qui est démontré

- Le moteur peut rejeter des graphes ou des permissions qui ne respectent pas
  son monde fermé.
- Les boucles, visites et transitions sont explicitement bornées.
- Une action conséquente simulée exige un chemin dominé par une approbation.
- Les exécutions de calibration sont reproductibles au niveau des octets.
- Les résultats de calibration et les essais avec un modèle réel ne sont pas
  mélangés.
- Le rapport permet de relier une recommandation aux contrôles, aux coûts
  synthétiques et aux chemins réellement exécutés.

## Ce qui n’est pas démontré

- La supériorité générale d’une architecture d’agents.
- Une économie réelle de dollars ou une amélioration mesurée en production.
- La sécurité d’un système d’identité, d’accès ou de déploiement réel.
- La qualité sémantique sur des tâches représentatives d’une organisation.
- Une interprétation universelle de graphes dynamiques ou arbitraires.

L’«effet de production» inclus est une simulation de données. Le courtier
d’autorité local n’est pas un substitut à l’IAM, à un bac à sable, à une
approbation humaine réelle ou aux contrôles d’une plateforme de production.

## Utilité pour une organisation

Le laboratoire peut servir de référence pour préparer une étude d’architecture
avant un déploiement:

- l’équipe produit déclare les résultats attendus et les exigences
  obligatoires;
- l’équipe d’ingénierie définit quelques architectures comparables;
- les responsables de risque définissent les capacités et approbations;
- l’équipe d’évaluation utilise des tâches représentatives, des répétitions et
  des évaluateurs indépendants;
- la décision retient la plus petite architecture qui franchit toutes les
  barrières, puis documente les compromis.

Cette approche déplace la conversation de «combien d’agents pouvons-nous
ajouter?» vers «quelle complexité est justifiée par les preuves?».

## Prochaine étape crédible

Pour passer d’une démonstration à une étude décisionnelle, il faudrait utiliser
un corpus conservé à l’écart, plusieurs répétitions par cellule, des mesures
réelles de jetons et de latence, ainsi que des évaluateurs calibrés contre des
jugements humains. Il faudrait ensuite brancher les contrôles d’autorité à une
infrastructure réelle sans réutiliser le simulateur comme mécanisme de
sécurité.

[Étude de cas](case-study.md) ·
[Méthodologie](methodology.md) ·
[Modèle de menace](threat-model.md)
