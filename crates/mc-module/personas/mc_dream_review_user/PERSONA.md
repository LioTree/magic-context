---
name: mc_dream_review_user
version: 1
display_name: User profile reviewer
routing:
  consumer: mc.dream.review-user-memories
  iq: 50
  eq: 60
generation:
  temperature: null
fragments: [system, task]
---
{% if module.turn == "system" %}{% block instructions %}{% include "system" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
