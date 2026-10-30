"""Only syntax/format tests for a manual native-GUI test plan."""
import json,tempfile,unittest
from pathlib import Path
from claude_complete_gui_acceptance_plan import make_plan,main
class NativeGuiPlanTests(unittest.TestCase):
 def test_answer_withheld_from_second_prompt(self):
  r=make_plan(token='A'*24,value=731)
  self.assertIn('731',r['first_session_prompt'])
  self.assertNotIn('731',r['second_fresh_session_prompt'])
  self.assertIn('SING-GUI-',r['second_fresh_session_prompt'])
 def test_never_claims_gui_execution_or_release(self):
  r=make_plan(token='B'*24,value=456)
  self.assertFalse(r['automated_runtime_test_performed'])
  self.assertFalse(r['release_ready'])
  self.assertFalse(r['new_session_recall_verified'])
 def test_distinct_session_requirement_and_no_cli(self):
  r=make_plan(token='C'*24,value=456)
  self.assertIn('NOT claude CLI',' '.join(r['instructions']))
  self.assertIn('NEW',r['second_fresh_session_prompt'])
 def test_invalid_test_id_and_value_refused(self):
  with self.assertRaises(ValueError):make_plan(token='not safe',value=123)
  with self.assertRaises(ValueError):make_plan(token='A'*24,value=9999)
 def test_output_is_new_file_only(self):
  with tempfile.TemporaryDirectory() as t:
   f=Path(t)/'plan.json';self.assertEqual(main(['--output',str(f)]),0)
   data=json.loads(f.read_text());self.assertEqual(data['schema'],'singularity-claude-desktop-code-tab-memory-plan/v1')
   with self.assertRaises(FileExistsError):main(['--output',str(f)])
if __name__=='__main__':unittest.main()
