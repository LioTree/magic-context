---
name: mc_dream_verify
version: 1
display_name: Memory verifier
routing:
  consumer: mc.dream.verify
  iq: 70
generation:
  temperature: null
fragments: [system, task]
---
{% if module.turn == "system" %}{% block instructions %}{% include "system" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
