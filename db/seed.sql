-- Dados de exemplo. O hash da senha é injetado por scripts/seed.js
INSERT INTO clinics (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Clínica Demo');
INSERT INTO users (clinic_id, name, email, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'Gestor Demo', 'gestor@demo.test', ':hash', 'owner');

INSERT INTO procedures (id, clinic_id, name, default_price) VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Botox',1200),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Limpeza de pele',250),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Preenchimento',1800);

INSERT INTO patients (id, clinic_id, full_name, birth_date, phone, marketing_consent)
SELECT ('20000000-0000-0000-0000-00000000000' || i)::uuid, '00000000-0000-0000-0000-000000000001',
       'Paciente ' || i,
       CASE WHEN i = 1 THEN ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '30 years')::date   -- faz aniversário hoje
            ELSE date '1990-01-01' + i * 40 END,
       '+55119999000' || i, true
FROM generate_series(1,5) i;

INSERT INTO categories (id, clinic_id, name, kind, dre_group) VALUES
 ('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Procedimentos','income','receita_bruta'),
 ('30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Insumos','expense','custos_variaveis'),
 ('30000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Aluguel','expense','despesas_operacionais'),
 ('30000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Impostos sobre vendas','expense','deducoes');

-- 6 meses de atendimentos concluídos (2 por mês) com receita paga
INSERT INTO appointments (id, clinic_id, patient_id, procedure_id, starts_at, ends_at, status, price, completed_at)
SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
       ('20000000-0000-0000-0000-00000000000' || (1 + (m + k) % 5))::uuid,
       ('10000000-0000-0000-0000-00000000000' || (1 + (m + k) % 3))::uuid,
       d, d + interval '1 hour', 'done', (ARRAY[1200,250,1800])[1 + (m + k) % 3], d
FROM generate_series(0,5) m, generate_series(1,2) k,
     LATERAL (SELECT date_trunc('month', now()) - m * interval '1 month' + k * interval '3 days' AS d) x
WHERE d < now();

INSERT INTO transactions (clinic_id, type, category_id, appointment_id, description, amount, competence_date, due_date, status, paid_at)
SELECT clinic_id, 'income', '30000000-0000-0000-0000-000000000001', id, 'Atendimento', price,
       completed_at::date, completed_at::date, 'paid', completed_at
FROM appointments;

INSERT INTO transactions (clinic_id, type, category_id, description, amount, competence_date, due_date, status, paid_at)
SELECT '00000000-0000-0000-0000-000000000001', 'expense', '30000000-0000-0000-0000-000000000003', 'Aluguel', 2500,
       (date_trunc('month', now()) - m * interval '1 month')::date,
       (date_trunc('month', now()) - m * interval '1 month')::date + 5,
       CASE WHEN m = 0 THEN 'pending' ELSE 'paid' END,
       CASE WHEN m = 0 THEN NULL ELSE now() - m * interval '1 month' END
FROM generate_series(0,5) m;

-- Agenda de hoje
INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
VALUES ('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
        (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + interval '14 hours') AT TIME ZONE 'America/Sao_Paulo',
        (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') + interval '15 hours') AT TIME ZONE 'America/Sao_Paulo', 1200);

INSERT INTO products (id, clinic_id, name, unit, quantity, min_quantity, target_quantity) VALUES
 ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Toxina botulínica 100U','frasco',1,2,6),
 ('40000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Luvas M','caixa',10,3,10);

INSERT INTO protocols (id, clinic_id, procedure_id, name, instructions) VALUES
 ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  'Protocolo Botox','Assepsia, marcação, aplicação em 3 pontos, orientar não deitar por 4h.');
INSERT INTO protocol_items VALUES ('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',0.5);

INSERT INTO message_templates (id, clinic_id, kind, body) VALUES
 ('60000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','birthday','Parabéns, {{nome}}! 🎉 A equipe da clínica deseja um dia especial.'),
 ('60000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','followup','Olá {{nome}}, como está a recuperação? Qualquer dúvida, estamos à disposição.');
INSERT INTO followup_rules (clinic_id, days_after, template_id)
VALUES ('00000000-0000-0000-0000-000000000001', 1, '60000000-0000-0000-0000-000000000002');
