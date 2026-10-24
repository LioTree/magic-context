---
name: mc_dream_classify
version: 1
display_name: Memory classifier
routing:
  consumer: mc.dream.classify-memories
  iq: 50
generation:
  temperature: null
fragments: [system, task]
---
{% if module.turn == "system" %}{% block instructions %}{% include "system" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
