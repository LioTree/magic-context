---
name: mc_dream_curate
version: 1
display_name: Project memory curator
routing:
  consumer: mc.dream.curate
  iq: 70
generation:
  temperature: null
fragments: [system, task]
---
{% if module.turn == "system" %}{% block instructions %}{% include "system" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
