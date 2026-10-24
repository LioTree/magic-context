---
name: mc_dream_map
version: 1
display_name: Backing file mapper
routing:
  consumer: mc.dream.map-memories
  iq: 50
generation:
  temperature: null
fragments: [system, task]
---
{% if module.turn == "system" %}{% block instructions %}{% include "system" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
